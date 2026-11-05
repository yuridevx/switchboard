package main

// Леса keeper, держатель: команда hold и замороженный протокол держателя — так его видят keeper и Host. Процессы — этот тестовый файл в роли
// приложения. Источники свойств — в комментариях; без пометки — чьё: код.
import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Держатель копит вывод без хозяина и отдаёт его хозяину; второй хозяин вытесняет первого; чужой ключ — bad_key (чьё: код — «Протокол
// держателя — заморожен», «Подключается к нему только хозяин, по ключу»; план заморозки, «Держатель»: «накопление без хозяина»).
func TestEtHolderBufferAndOwner(t *testing.T) {
	// байты кадра — образец замороженного протокола; тот же образец проверяет Host
	var gb bytes.Buffer
	putFrame(&gb, kAuth, []byte("key"))
	if gb.String() != "a\x00\x00\x00\x03key" {
		t.Fatalf("кадр %q", gb.String())
	}
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "x", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self(), "app"}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	// хозяин — байтами замороженного протокола: 'a', длина big-endian, ключ; ответ — 'h' с JSON ровно {pid, buffered}
	raw, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port))
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 5, 5+len(f.Key))
	auth[0] = 'a'
	binary.BigEndian.PutUint32(auth[1:5], uint32(len(f.Key)))
	raw.Write(append(auth, f.Key...))
	var hdr [5]byte
	if _, err := io.ReadFull(raw, hdr[:]); err != nil || hdr[0] != 'h' {
		t.Fatalf("ответ на ключ %q %v", hdr[:], err)
	}
	body := make([]byte, binary.BigEndian.Uint32(hdr[1:5]))
	io.ReadFull(raw, body)
	var hello map[string]any
	json.Unmarshal(body, &hello)
	if len(hello) != 2 || hello["pid"] != float64(f.Pid) || hello["buffered"] == float64(0) || hello["buffered"] == nil {
		t.Fatalf("hello %s", body)
	}
	c1 := &ownerConn{c: raw}
	var first strings.Builder
	firstDone := make(chan error, 1)
	go func() {
		x, err := c1.read(func(b []byte) { first.Write(b) })
		if x != nil {
			err = fmt.Errorf("прежнему хозяину отдан выход %+v", x)
		}
		firstDone <- err
	}()
	c2, hh, err := attachHeld(f)
	if err != nil || hh.Pid != f.Pid {
		t.Fatalf("второй хозяин: %+v %v", hh, err)
	}
	if err := <-firstDone; err == nil || !strings.Contains(first.String(), "app 1 start") {
		t.Fatalf("прежний хозяин не вытеснен или без накопленного: %v %q", err, first.String())
	}
	waitFor(t, "строка held_replaced", func() bool { return has(home, J{"ev": "held_replaced"}) && has(home, J{"ev": "held_attach"}) })
	bad := f
	bad.Key = "nope"
	if _, _, err := attachHeld(bad); err == nil || !strings.Contains(err.Error(), "bad_key") {
		t.Fatalf("чужой ключ: %v", err)
	}
	// выход процесса — у второго хозяина
	c2.closeInput()
	if x, err := c2.read(func([]byte) {}); err != nil || x == nil {
		t.Fatalf("выход второму хозяину %v %v", x, err)
	}
}

// 5507 · 5513 · Держатель ждёт хозяина, пока процесс жив, сколько бы ни шло времени: предел ожидания считается только от выхода процесса;
// процесс вышел, хозяина нет — держатель ждёт его не дольше ownerWait: строка held_unclaimed с причиной, файл убран, держатель вышел (устав,
// закрытый список: «держатели живут, keeper подключается к своим»; ubuntu-db 3 нояб.: после снятия keeper держатель Host ждал хозяина без
// предела; устав: «у всех операций лимит»).
func TestEtHolderUnclaimedExit(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=300ms"), Cmd: []string{self(), "app"}})
	if err != nil {
		t.Fatal(err)
	}
	hf := heldOf(home, "s")
	time.Sleep(time.Second)
	if !isThere(heldPath(home, "s")) || has(home, J{"ev": "held_unclaimed"}) {
		t.Fatal("держатель живого процесса ушёл")
	}
	c, hh, err := attachHeld(f)
	if err != nil || hh.Pid != f.Pid {
		t.Fatalf("hello %+v %v", hh, err)
	}
	c.Close()
	killPid(t, f.Pid)
	waitFor(t, "держатель вышел", func() bool { return !isThere(heldPath(home, "s")) && !alive(hf.Holder) })
	if !has(home, J{"ev": "held_unclaimed", "why": sub("300ms")}) || !has(home, J{"ev": "held_exit"}) {
		t.Fatal("нет строки held_exit или held_unclaimed с причиной")
	}
}

// 5509 · Хозяин получил выход и держит соединение — держатель всё равно выходит через ownerWait: файл убран, строки held_unclaimed нет — выход
// забран (устав: «у всех операций лимит»).
func TestEtHolderExitTakenOwnerStays(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=300ms"), Cmd: []string{self(), "app"}})
	if err != nil {
		t.Fatal(err)
	}
	hf := heldOf(home, "s")
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.closeInput()
	if x, err := c.read(func([]byte) {}); err != nil || x == nil {
		t.Fatalf("выход %+v %v", x, err)
	}
	// соединение остаётся открытым
	waitFor(t, "держатель вышел", func() bool { return !isThere(heldPath(home, "s")) && !alive(hf.Holder) })
	if has(home, J{"ev": "held_unclaimed"}) {
		t.Fatal("held_unclaimed при забранном выходе")
	}
}

// 5518 · Соединение без кадра ключа держатель закрывает за 10 с словом bad_key; держатель и процесс живут, хозяин с ключом подключается
// (устав: «у всех операций должен быть лимит», слово пользователя 2 нояб.).
func TestEtHolderNoKeyClosed(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self(), "app"}})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	start := time.Now()
	raw.SetReadDeadline(time.Now().Add(15 * time.Second))
	ty, body, err := getFrame(raw)
	if err != nil || ty != kError || string(body) != "bad_key" || time.Since(start) < 9*time.Second {
		t.Fatalf("кадр %q %q %v за %v", ty, body, err, time.Since(start))
	}
	if !alive(f.Pid) {
		t.Fatal("процесс умер")
	}
	c, hh, err := attachHeld(f)
	if err != nil || hh.Pid != f.Pid {
		t.Fatalf("хозяин не подключился: %+v %v", hh, err)
	}
	c.Close()
}

// Процесс не читает ввод: 256 КБ ввода и «убей» — процесс снят меньше чем за секунду, хозяин получил выход SIGKILL (план заморозки, находка
// «Убей»; опыт 1 нояб. на 0.5.6: от 8 КБ процесс жив через 8 с).
func TestEtHolderKillBehindInput(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "d", Owner: "host", Env: os.Environ(), Cmd: []string{self(), "app", "deaf"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	go func() {
		chunk := make([]byte, 32*1024)
		for i := 0; i < 8; i++ {
			if c.send(kInput, chunk) != nil {
				return
			}
		}
		c.kill()
	}()
	x, err := c.read(func([]byte) {})
	d := time.Since(start)
	if err != nil || x == nil || x.Signal == nil || *x.Signal != "SIGKILL" {
		t.Fatalf("выход %+v %v", x, err)
	}
	if d > time.Second {
		t.Fatalf("снят через %v", d)
	}
	waitFor(t, "процесс снят", func() bool { return !alive(f.Pid) })
}

// Держатель запустил процесс: хозяину — порт, ключ и pid строкой о себе, то же — в файле procs/<id>.json; строки держателя — под тем, чей
// процесс он держит: часть машины — её именем, сессия Host — host и callsign (чьё: код — «пишет о себе … procs/<id>.json … и одной строкой то
// же — в свой stdout», «строки держателя — под тем, чей процесс он держит»).
func TestEtHolderJournalOwner(t *testing.T) {
	home := holderHome(t)
	fp, err := holdProc(home, holdReq{ID: "capture", Owner: "keeper", Tag: "1.3.2", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1.3.2"), Cmd: []string{self(), "app"}})
	if err != nil {
		t.Fatal(err)
	}
	fh, err := holdProc(home, holdReq{ID: "site@win", Owner: "host", Env: os.Environ(), Cmd: []string{self(), "app"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []heldFile{fp, fh} {
		disk := heldOf(home, f.ID)
		if f.Port == 0 || len(f.Key) != 64 || !alive(f.Pid) || disk.Port != f.Port || disk.Key != f.Key || disk.Pid != f.Pid || disk.Owner != f.Owner {
			t.Fatalf("о себе %+v, в файле %+v", f, disk)
		}
	}
	waitFor(t, "stderr части в журнале", func() bool { return has(home, J{"id": "capture", "line": "app: stderr line"}) })
	if r := find(home, J{"id": "capture", "line": "app: stderr line"}); r["part"] != "capture" || r["who"] != "holder" {
		t.Fatalf("строка держателя части %v", r)
	}
	if r := find(home, J{"ev": "hold", "callsign": "site@win"}); r == nil || r["part"] != "host" || r["who"] != "holder" {
		t.Fatalf("строка держателя сессии %v", r)
	}
}

// Ввод доходит до процесса по порядку, «закрой ввод» — после всего ввода из очереди; процесс вышел кодом 0 (план заморозки, «Держатель»:
// «процесс, его ввод и вывод… Им же пользуется Host для сессий»; находка «Убей»: «„Закрой ввод“ встаёт в очередь за вводом»).
func TestEtHolderInputInOrder(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "e", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self(), "app", "echo"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range []string{"a\n", "b\n", "c\n"} {
		c.send(kInput, []byte(l))
	}
	c.closeInput()
	var out strings.Builder
	x, err := c.read(func(b []byte) { out.Write(b) })
	if err != nil || x == nil || x.Code == nil || *x.Code != 0 {
		t.Fatalf("выход %+v %v", x, err)
	}
	if !strings.Contains(out.String(), "echo a\necho b\necho c\nbye\n") {
		t.Fatalf("вывод %q", out.String())
	}
}

// Процесс вышел: держатель снимает его потомков (иначе они держали бы трубу вывода), отдаёт хозяину кадр выхода с кодом и последней строкой
// stderr после всего вывода; хозяин закрыл соединение — держатель убирает свой файл и выходит (чьё: код — «Процесс вышел, выход отдан хозяину
// и хозяин закрыл соединение — файл убран, держатель вышел», «процесс вышел — его дети в задании тоже»).
func TestEtHolderExitKillsDescendants(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "p", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self(), "app", "parent"}})
	if err != nil {
		t.Fatal(err)
	}
	hf := heldOf(home, "p")
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	var out lockedText
	type res struct {
		x   *heldExit
		err error
	}
	done := make(chan res, 1)
	go func() {
		x, err := c.read(out.add)
		done <- res{x, err}
	}()
	waitFor(t, "потомок запущен", func() bool { return childPid(out.String()) != 0 })
	child := childPid(out.String())
	if !alive(child) {
		t.Fatal("потомок не жив")
	}
	c.closeInput()
	var r res
	select {
	case r = <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("выхода нет — потомок держит трубу")
	}
	if r.err != nil || r.x == nil || r.x.Code == nil || *r.x.Code != 0 || r.x.Stderr != "app: stderr line" {
		t.Fatalf("выход %+v %v", r.x, r.err)
	}
	if !strings.Contains(out.String(), "bye") {
		t.Fatalf("вывод до выхода %q", out.String())
	}
	waitFor(t, "потомок снят", func() bool { return !alive(child) })
	c.Close() // хозяин получил выход и закрыл соединение, как keeper и Host
	waitFor(t, "файл держателя убран", func() bool { return !isThere(heldPath(home, "p")) })
	waitFor(t, "держатель вышел", func() bool { return !alive(hf.Holder) })
}

// Процесс вышел без хозяина — держатель жив, его файл на месте, выход хранится; хозяин пришёл и читает медленно — всё равно получает hello,
// накопленный вывод и кадр выхода убитого процесса; хозяин закрыл соединение — файл убран, держатель вышел (устав, закрытый список: «keeper
// умер или подменил себя — …держатели живут, keeper подключается к своим»; находка цикла 2 нояб.: 2 из 50 прогонов на Windows — wsarecv
// «forcibly closed»: держатель выходил с открытым соединением, Windows сбрасывал его и выбрасывал непрочитанное хозяином).
func TestEtHolderKeepsExitForOwner(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "slow", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self(), "app"}})
	if err != nil {
		t.Fatal(err)
	}
	hf := heldOf(home, "slow")
	time.Sleep(500 * time.Millisecond) // строка о старте написана
	killPid(t, f.Pid)
	waitFor(t, "процесс убит", func() bool { return !alive(f.Pid) })
	time.Sleep(500 * time.Millisecond)
	if !isThere(heldPath(home, "slow")) || !alive(hf.Holder) {
		t.Fatal("держатель не дождался хозяина")
	}
	raw, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port))
	if err != nil {
		t.Fatal(err)
	}
	if err := putFrame(raw, kAuth, []byte(f.Key)); err != nil {
		t.Fatal(err)
	}
	// хозяин занят: держатель успевает отдать hello, накопленное и выход раньше, чем хозяин читает
	time.Sleep(time.Second)
	ty, body, err := getFrame(raw)
	if err != nil || ty != kHello {
		t.Fatalf("hello: %q %v", ty, err)
	}
	var hh heldHello
	json.Unmarshal(body, &hh)
	var out strings.Builder
	x, err := (&ownerConn{c: raw}).read(func(b []byte) { out.Write(b) })
	killed := x != nil && ((x.Code != nil && *x.Code == 3) || (x.Signal != nil && *x.Signal == "SIGKILL"))
	if hh.Pid != f.Pid || err != nil || !killed || !strings.Contains(out.String(), "app 1 start") {
		t.Fatalf("hello %+v, выход %+v %v, вывод %q", hh, x, err, out.String())
	}
	raw.Close()
	waitFor(t, "файл держателя убран", func() bool { return !isThere(heldPath(home, "slow")) })
	waitFor(t, "держатель вышел", func() bool { return !alive(hf.Holder) })
}

// Кадр вывода не больше предела протокола 4 МиБ: без хозяина накопилось больше — хозяин получает всё кусками (кадр выше предела рвёт связь; Host:
// «держатель не примет кадр больше 4 МиБ»; чьё: код — «кадр больше — сбой соединения: вывод режется на куски»).
func TestEtHolderOutputInChunks(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "f", Owner: "host", Env: os.Environ(), Cmd: []string{self(), "app", "flood"}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second) // процесс пишет без хозяина, держатель копит до предела
	c, hh, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if hh.Buffered < 4<<20 {
		t.Fatalf("накоплено %d", hh.Buffered)
	}
	total, biggest := 0, 0
	c.c.SetReadDeadline(time.Now().Add(20 * time.Second))
	for total < 80*64<<10 {
		ty, b, err := getFrame(c.c)
		if err != nil {
			t.Fatalf("после %d байт: %v", total, err)
		}
		if ty == kOut {
			total += len(b)
			biggest = max(biggest, len(b))
		}
	}
	if biggest > 1<<20 {
		t.Fatalf("кадр вывода %d байт", biggest)
	}
}

// Неверные аргументы держателя — отказ словами, код 2, процесс не запущен, файла нет (устав: система ловит).
func TestEtHoldBadArgs(t *testing.T) {
	for _, args := range [][]string{{"--id", "../x", "--owner", "keeper", "--", self(), "app"}, {"--id", "a", "--owner", "bob", "--", self(), "app"},
		{"--id", "a", "--owner", "keeper"}} {
		home := t.TempDir()
		cmd := exec.Command(self(), append([]string{"hold"}, args...)...)
		cmd.Env = append(os.Environ(), "SWITCHBOARD_HOME="+home)
		var e strings.Builder
		cmd.Stderr = &e
		cmd.Run()
		if cmd.ProcessState.ExitCode() != 2 || !strings.Contains(e.String(), "hold") || len(heldFiles(home)) != 0 {
			t.Fatalf("hold %v: код %d, %q", args, cmd.ProcessState.ExitCode(), e.String())
		}
	}
}

// 5564 · Host запускает держатель с --cwd папкой сессии (host/core holders.ts): рабочая папка процесса — она; держатель имя флота не
// разбирает: --name в команде процесса доходит до процесса как есть, папка держателя — из SWITCHBOARD_HOME (дизайн этапа 0: «Host и
// держателям папку передаёт в SWITCHBOARD_HOME — они её не выводят»; контракт команды hold снаружи).
func TestEtHoldCwdAndArgs(t *testing.T) {
	u := nameStand(t)
	home, dir := t.TempDir(), t.TempDir()
	t.Cleanup(func() { killHolders(home) })
	c := holdCmd(t, home, "--id", "s", "--owner", "host", "--cwd", dir, "--", self(), "app", "env", "--name", "y")
	c.closeInput()
	var out strings.Builder
	c.read(func(b []byte) { out.Write(b) })
	if !strings.Contains(out.String(), "args env --name y") {
		t.Fatalf("вывод процесса: %q", out.String())
	}
	i := strings.Index(out.String(), "CWD=")
	if i < 0 {
		t.Fatalf("вывод %q", out.String())
	}
	want, _ := os.Stat(dir)
	got, _ := os.Stat(strings.TrimSpace(strings.SplitN(out.String()[i+4:], "\n", 2)[0]))
	if got == nil || !os.SameFile(got, want) {
		t.Fatalf("рабочая папка: вывод %q, а надо %s", out.String(), dir)
	}
	if _, err := os.Stat(filepath.Join(u, ".switchboard-y")); !os.IsNotExist(err) {
		t.Fatalf("папка по имени из команды процесса: %v", err)
	}
}

// Потомок вне задания (--detach-children) держит трубу вывода после выхода процесса — кадр выхода не ждёт его жизни (устав: «у всех операций
// лимит»; на Linux потомок снят с группой, предел не нужен; опыт 5 нояб. на Windows).
func TestEtExitNotHeldByDetachedChild(t *testing.T) {
	home := t.TempDir()
	t.Cleanup(func() { killHolders(home) })
	c := holdCmd(t, home, "--id", "p", "--owner", "host", "--detach-children", "--", self(), "app", "parent")
	var out lockedText
	done := make(chan *heldExit, 1)
	go func() {
		x, _ := c.read(out.add)
		done <- x
	}()
	waitFor(t, "потомок запущен", func() bool { return childPid(out.String()) != 0 })
	child := childPid(out.String())
	t.Cleanup(func() {
		if alive(child) {
			if pr, err := os.FindProcess(child); err == nil {
				pr.Kill()
			}
		}
	})
	c.closeInput()
	select {
	case x := <-done:
		if x == nil || x.Code == nil || *x.Code != 0 {
			t.Fatalf("выход %+v", x)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("кадр выхода ждёт жизнь потомка")
	}
}
