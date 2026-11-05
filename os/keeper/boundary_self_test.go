package main

// Леса keeper, сам keeper: подмена себя по плану, команда version, установка машины приглашением, флот под именем. Источники свойств — в
// комментариях; без пометки — чьё: код.
import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Подмена себя: последним шагом плана, где бы ни стояла запись keeper; прежние файлы keeper — с версией и pid и от установки — убраны на
// старте; новый файл ответил своей версией → часть уже на новой версии, свой файл подменён, part.updated и выход; держатели живут; версии
// keeper на диске — новая и та, с которой ушли; занятое прежнее имя файла не мешает (план заморозки, «Подмена себя»: «По плану, последним
// шагом; держатели живут»; находка «Подмена себя после отката»: «Уборка на старте находит их тем же шаблоном»; машины 1 нояб.: 6 версий,
// 77 МБ; ревью 1 нояб.: Access is denied на Windows).
func TestEtSelfUpdate(t *testing.T) {
	s := newStand(t)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), binName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	olds := []string{target + ".0.9.0.4242.old", target + ".prev.77.old"}
	for _, o := range olds {
		os.WriteFile(o, []byte("old"), 0o755)
	}
	busy := target + "." + ourVersion + ".old"
	os.WriteFile(busy, []byte("epoch 1"), 0o755)
	h, err := os.Open(busy)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for _, v := range []string{"0.0.1", ourVersion} {
		os.MkdirAll(verDir(s.home, "keeper", v), 0o700)
	}
	bin, _ := os.ReadFile(self())
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", keeperFile(), nil), s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.startWith(tuning{self: func() (string, error) { return target, nil }})
	select {
	case <-k.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	if b, _ := os.ReadFile(target); len(b) != len(bin) {
		t.Fatal("файл keeper не подменён")
	}
	for _, o := range olds {
		if isThere(o) {
			t.Fatalf("прежний файл не убран: %s", o)
		}
	}
	if ms, _ := filepath.Glob(target + "." + ourVersion + ".*.old"); len(ms) != 1 {
		t.Fatalf("старый файл не переименован: %v", ms)
	}
	if f := heldFiles(s.home); len(f) != 1 || !alive(f[0].Pid) {
		t.Fatal("держатель приложения не пережил подмену keeper")
	}
	waitFor(t, "part.updated keeper", func() bool { return s.relay.ledgerHas("part.updated", "keeper", ourVersion, "9.9.9") })
	update := index(s.home, J{"ev": "self_update", "from": ourVersion, "to": "9.9.9"})
	if update < 0 || find(s.home, J{"ev": "self_update"})["why"] == nil {
		t.Fatal("нет строки self_update с причиной")
	}
	if a := index(s.home, J{"ev": "part_start", "version": "1.3.2"}); a < 0 || a > update {
		t.Fatalf("порядок: part_start capture %d, self_update %d", a, update)
	}
	if got := dirNames(partFolder(s.home, "keeper")); got != ourVersion+" 9.9.9" {
		t.Fatalf("версии keeper: %v", got)
	}
}

// Новый файл keeper не тот — не ответил на version за предел (убит) или ответил не той версией: keeper failed check_failed с причиной в журнале
// машины и флота, остальной план исполнен, keeper не выходит; следующий план с той же записью пробует подмену снова; план с работающей версией
// keeper снимает failed и ничего не подменяет (чьё: код — решение архитектора 2 нояб.: повтор с диска дешёвый, каждый сбой в журнале флота;
// слово пользователя 2 нояб.: «у всех операций должен быть лимит»).
func TestEtSelfCheckFailed(t *testing.T) {
	s := newStand(t)
	t.Setenv("KEEPER_TEST_VERSION_HANG", "1")
	kp := s.links.part("keeper", "9.9.9", keeperFile(), nil)
	capture := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.relay.setPlan(plan1(1, kp, capture))
	k := s.startWith(tuning{stop: 1500 * time.Millisecond})
	waitFor(t, "check_failed за предел", func() bool {
		e := partOf(k, "keeper").Error
		return strings.Contains(e, "check_failed") && strings.Contains(e, "1.5s")
	})
	waitFor(t, "остальной план", running(k, "capture", ""))
	notExited(t, k)
	t.Setenv("KEEPER_TEST_VERSION_HANG", "")
	t.Setenv("KEEPER_TEST_VERSION", "1.0.0")
	s.online()
	s.relay.push(planMsg(2, kp, capture))
	waitFor(t, "второй сбой", func() bool { return s.relay.ledgerCount("part.failed", "keeper", "9.9.9", "check_failed") == 2 })
	if !has(s.home, J{"ev": "part_failed", "why": sub("1.0.0")}) {
		t.Fatal("в журнале машины нет ответа нового файла")
	}
	notExited(t, k)
	s.relay.push(planMsg(3, s.links.part("keeper", ourVersion, files{"x": "x"}, nil), capture))
	waitFor(t, "failed снят", func() bool { return partOf(k, "keeper").State == "" })
	time.Sleep(500 * time.Millisecond)
	notExited(t, k)
	if has(s.home, J{"ev": "self_update"}) {
		t.Fatal("подмена себя на работающую версию")
	}
}

// Подмена файла не удалась — keeper failed «подмена: …», part.failed, свой файл прежний, keeper не вышел (устав: система ловит; чьё: код —
// «Не вышло — dst прежний», «Сбой — keeper failed, как у любой части»).
func TestEtSelfUpdateReplaceFails(t *testing.T) {
	s := newStand(t)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), binName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	// копию рядом не записать: на её месте непустая папка
	os.Mkdir(target+".new", 0o700)
	os.WriteFile(filepath.Join(target+".new", "x"), nil, 0o600)
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", keeperFile(), nil)))
	k := s.startWith(tuning{self: func() (string, error) { return target, nil }})
	waitFor(t, "failed подмена", func() bool {
		p := partOf(k, "keeper")
		return p.State == "failed" && strings.HasPrefix(p.Error, "подмена: ")
	})
	waitFor(t, "part.failed keeper", func() bool { return s.relay.ledgerHas("part.failed", "keeper", "9.9.9", "подмена") })
	notExited(t, k)
	if b, _ := os.ReadFile(target); string(b) != "old" {
		t.Fatal("свой файл keeper тронут")
	}
}

// version — номер выпуска из module.json; неизвестная команда — подсказка со всеми командами и код 2 (чьё: код; подмена себя сверяет ответ
// version с планом).
func TestEtVersionAndUsage(t *testing.T) {
	if code, out, _ := runKeeper(t, t.TempDir(), "", "version"); code != 0 || strings.TrimSpace(out) != ourVersion {
		t.Fatalf("version: код %d, %q, а в module.json %s", code, out, ourVersion)
	}
	code, _, e := runKeeper(t, t.TempDir(), "", "nope")
	for _, w := range []string{"run", "install", "uninstall", "hold", "version", "--name"} {
		if code != 2 || !strings.Contains(e, w) {
			t.Fatalf("неизвестная команда: код %d, %q", code, e)
		}
	}
}

// 5522 · Без имени — служба и папка прежние, команда run; имя с путём — отказ словом; --worker не вида имя=адрес — отказ (дизайн этапа 0).
func TestEtNameAbsentSameAsBefore(t *testing.T) {
	u := nameStand(t)
	rest, err := chooseFleet([]string{"--hide"})
	if err != nil || !reflect.DeepEqual(rest, []string{"--hide"}) {
		t.Fatalf("%v %v", rest, err)
	}
	home, _ := fleetHome()
	if fleetService() != "switchboard-keeper" || home != filepath.Join(u, ".switchboard") || !reflect.DeepEqual(fleetCommand(), []string{"run"}) {
		t.Fatalf("служба %q, папка %q, команда %v", fleetService(), home, fleetCommand())
	}
	for _, bad := range [][]string{{"--name"}, {"--name", "../x"}, {"--name", ""}} {
		if _, err := chooseFleet(bad); err == nil || !strings.Contains(err.Error(), "--name") {
			t.Fatalf("%v: %v", bad, err)
		}
	}
	if code, _, e := runKeeper(t, t.TempDir(), "", "install", "--worker", "x"); code != 1 || !strings.Contains(e, "--worker") || !strings.Contains(e, `"x"`) {
		t.Fatalf("плохой --worker: код %d, %q", code, e)
	}
}

// 5565 · Приглашение не принято — отказ словом с причиной от gate; службы, задачи, юнита и папки этого имени нет, первый флот не тронут (устав
// «система ловит»; чьё: код — «погашенное или чужое — отказ словом»).
func TestEtNameInviteRefused(t *testing.T) {
	u := nameStand(t)
	t.Setenv("XDG_CONFIG_HOME", u)
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"type": "reply", "id": "install", "ok": false, "error": "bad_invite"})
	}))
	defer gate.Close()
	name := fmt.Sprintf("t%dr", os.Getpid())
	code, _, e := runKeeper(t, t.TempDir(), "invite\n", "install", "--name", name, "--worker", "gate="+gate.URL)
	if code != 1 || !strings.Contains(e, "bad_invite") {
		t.Fatalf("код %d, %q", code, e)
	}
	for _, p := range []string{".switchboard-" + name, ".switchboard", filepath.Join("systemd", "user", "switchboard-keeper-"+name+".service")} {
		if _, err := os.Stat(filepath.Join(u, p)); !os.IsNotExist(err) {
			t.Fatalf("%s появилось: %v", p, err)
		}
	}
	if runtime.GOOS == "windows" {
		if exec.Command("schtasks", "/Query", "/TN", "switchboard-keeper-"+name).Run() == nil || exec.Command("sc", "query", "switchboard-keeper-"+name).Run() == nil {
			t.Fatal("служба или задача создана")
		}
	}
}

// 5084 · 5521 · 5561 · Установка: приглашение машины — первой строкой stdin; keeper принимает его POST gate.redeem и кладёт пропуск в
// machine.key; keeper.json — node из PATH полным путём, relay и Worker'ы из флагов, незнакомые поля целы; install --name prod: служба
// switchboard-keeper-prod, папка ~/.switchboard-prod, команда службы run --name prod; файл keeper — в своей папке, файл первого флота не
// заменён (дизайн «Открытый флот»; дизайн «Любой агент», этап 0: «keeper обновляет файл в своей папке»; устав: секреты через stdin; чьё:
// код — «Незнакомые поля сохраняются как есть»).
func TestEtInstall(t *testing.T) {
	u := nameStand(t)
	first := filepath.Join(u, ".switchboard", binName("keeper"))
	os.MkdirAll(filepath.Dir(first), 0o700)
	os.WriteFile(first, []byte("первый флот"), 0o755)
	r := newFakeRelay(t)
	bin := t.TempDir()
	node := filepath.Join(bin, binName("node"))
	os.WriteFile(node, []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", bin)
	rest, err := chooseFleet([]string{"--name", "prod", "--worker", "relay=https://relay.test/", "--worker", "gate=" + r.workerURL("gate"),
		"--worker", "releases=https://releases.test/", "--worker", "ledger=https://ledger.test/"})
	if err != nil {
		t.Fatal(err)
	}
	if fleetService() != "switchboard-keeper-prod" || !reflect.DeepEqual(fleetCommand(), []string{"run", "--name", "prod"}) {
		t.Fatalf("служба %q, команда %v", fleetService(), fleetCommand())
	}
	home, _ := fleetHome()
	if want := filepath.Join(u, ".switchboard-prod"); home != want {
		t.Fatalf("папка %q, а надо %q", home, want)
	}
	saveConf(home, map[string]any{"site": "lab"})
	dst, err := prepareMachine(rest, bufio.NewReader(strings.NewReader("win1.INVITE\r\npassword\n")))
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "machine.key")); string(b) != "host.win.win1.SECRET\n" {
		t.Fatalf("machine.key %q", b)
	}
	m, _ := loadConf(home)
	w := confWorkers(m)
	if m["node"] != node || m["relay"] != nil || w["relay"] != "https://relay.test/" || m["site"] != "lab" || w["releases"] != "https://releases.test/" || w["ledger"] != "https://ledger.test/" {
		t.Fatalf("keeper.json %v", m)
	}
	a, _ := os.Stat(self())
	b, _ := os.Stat(dst)
	if dst != filepath.Join(home, binName("keeper")) || b == nil || a.Size() != b.Size() {
		t.Fatalf("файл keeper %q", dst)
	}
	if got, _ := os.ReadFile(first); string(got) != "первый флот" {
		t.Fatalf("файл первого флота заменён: %d байт", len(got))
	}
}

// 5084 · Приглашение не машины, нет адреса gate или пустой stdin — отказ словами, machine.key не тронут (устав: система ловит — отказывает).
func TestEtInstallKeyRefused(t *testing.T) {
	r := newFakeRelay(t)
	for _, c := range []struct{ in, gate, fact string }{
		{"phn1.INVITE\n", r.workerURL("gate"), "client.phone.phn1"},
		{"win1.INVITE\n", "", "gate"},
		{"", r.workerURL("gate"), "stdin"},
	} {
		home := t.TempDir()
		t.Setenv("SWITCHBOARD_HOME", home)
		saveConf(home, map[string]any{"node": "/x/node"})
		os.WriteFile(filepath.Join(home, "machine.key"), []byte("host.win.old1.OLD\n"), 0o600)
		args := []string{}
		if c.gate != "" {
			args = append(args, "--worker", "gate="+c.gate)
		}
		_, err := prepareMachine(args, bufio.NewReader(strings.NewReader(c.in)))
		if b, _ := os.ReadFile(filepath.Join(home, "machine.key")); err == nil || !strings.Contains(err.Error(), c.fact) || strings.Contains(err.Error(), "SECRET") || string(b) != "host.win.old1.OLD\n" {
			t.Fatalf("stdin %q: %v, machine.key %q", c.in, err, b)
		}
	}
}

// 5523 · 5567 · keeper run --name работает в своей папке; под именем умер — та же команда подключается к держателям своей папки; второй keeper
// этого не замечает (устав, закрытый список: «keeper умер… ОС поднимает его, держатели живут, keeper подключается к своим»; дизайн этапа 0
// «ничего не знает о второй»).
func TestEtNameAdoptOwnHolders(t *testing.T) {
	u := nameStand(t)
	a := newNamedKeeper(t, u, "a")
	b := newNamedKeeper(t, u, "b")
	pidA, pidB := a.partPid(), b.partPid()
	if pidA == pidB {
		t.Fatalf("одна часть на двоих: pid %d", pidA)
	}
	a.kill()
	if !alive(pidA) {
		t.Fatal("часть a умерла вместе с keeper")
	}
	a.run()
	waitFor(t, "adopt своей части", func() bool { return has(a.own, J{"ev": "adopt", "id": "capture", "pid": pidA}) })
	if n := count(a.own, J{"ev": "part_start"}); n != 1 {
		t.Fatalf("часть a запущена %d раз", n)
	}
	if has(b.own, J{"ev": "adopt"}) || count(b.own, J{"ev": "part_start"}) != 1 || !alive(pidB) || b.cmd.ProcessState != nil {
		t.Fatalf("второй keeper задет: %s", journalAll(b.own))
	}
	if _, err := os.Stat(filepath.Join(u, ".switchboard")); !os.IsNotExist(err) {
		t.Fatalf("прежняя папка появилась: %v", err)
	}
}
