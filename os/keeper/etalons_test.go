package main

// Эталоны keeper — исполнителя плана, и держателя. Источники свойств — дизайн «Выпуски флота» (слово пользователя
// 1 нояб.: состояние машины спускается сверху, keeper исполняет и отвечает состояние, держатели) и замеры 1 нояб.
import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

var on = map[string]any{"on": true}

// Поставить по плану: при подключении keeper спрашивает план у «выпусков», архив скачан по ссылке, хэш сверен, держатель
// запускает run из app.json в папке data/, ответ сохранён в plan.json (план заморозки: «Спросить при подключении…
// хранить на диске»; «Скачать по ссылке, сверить sha256, распаковать, выполнить setup, отметить папку»).
func TestEtPlanInstallAndRun(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "capture running", func() bool { return partOf(k, "capture").State == "running" })
	// вопрос — по контракту с «выпусками»: releases.plan v1 на .releases с id
	if q := s.relay.firstAsk(); q["v"] != float64(1) || q["to"] != ".releases" || q["id"] == "" || q["id"] == nil {
		t.Fatalf("вопрос о плане %v", q)
	}
	p := partOf(k, "capture")
	if p.Version != "1.3.2" || p.Pid == 0 {
		t.Fatalf("state %+v", p)
	}
	if !exists(filepath.Join(s.home, "parts", "capture", "data")) || !exists(filepath.Join(s.home, "parts", "capture", "1.3.2", "release.sha256")) {
		t.Fatal("нет папки версии или data/")
	}
	waitFor(t, "вывод в журнале", func() bool { return journalHas(s.home, `"line":"app 1.3.2 start`) })
	var saved plan
	b, _ := os.ReadFile(planPath(s.home))
	if json.Unmarshal(b, &saved) != nil || saved.Rev != 1 || len(saved.Parts) != 1 || saved.Parts[0].Version != "1.3.2" {
		t.Fatalf("plan.json — не ответ «выпусков»: %s", b)
	}
}

// Хэш не сошёлся: download_failed в keeper.state, прежняя версия работает.
func TestEtBadHashKeepsOld(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	bad := s.links.part("capture", "1.4.0", appFiles(""), on)
	bad["sha256"] = strings.Repeat("0", 64)
	s.relay.push(planMsg(2, bad))
	waitFor(t, "download_failed", func() bool { return strings.Contains(partOf(k, "capture").Error, "download_failed") })
	p := partOf(k, "capture")
	if p.State != "running" || p.Pid != pid || p.Version != "1.3.2" {
		t.Fatalf("прежняя версия тронута: %+v", p)
	}
	if exists(versionDir(s.home, "capture", "1.4.0")) {
		t.Fatal("папка битой версии осталась")
	}
	// выкладка не доехала — это видно и в журнале флота
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.4.0 — download_failed") })
	// app.json новой версии с чужим полем — версия негодна до остановки прежней (ревью архитектора 1 нояб.)
	app := appFiles("")
	app["app.json"] = `{"run":["x"],"user":"admin"}`
	s.relay.push(planMsg(3, s.links.part("capture", "1.5.0", app, on)))
	waitFor(t, "contract_mismatch", func() bool { return strings.Contains(partOf(k, "capture").Error, "contract_mismatch") })
	if p := partOf(k, "capture"); p.State != "running" || p.Pid != pid || p.Version != "1.3.2" {
		t.Fatalf("прежняя версия остановлена ради негодной: %+v", p)
	}
	waitFor(t, "part.failed 1.5.0", func() bool { return s.relay.ledgerHas("part.failed capture 1.5.0 — contract_mismatch") })
}

// Смена версии без наложения: новая стартует после выхода старой; part.updated; на диске — новая и предыдущая
// (план заморозки: «убрать версии, кроме текущей и предыдущей»).
func TestEtVersionSwitchNoOverlap(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	os.MkdirAll(versionDir(s.home, "capture", "0.9.0"), 0o700) // версия позапрошлой выкладки
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "1.4.0 running", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.4.0" })
	waitFor(t, "part.updated", func() bool { return s.relay.ledgerHas("part.updated capture 1.3.2 → 1.4.0") })
	// старая вышла сама после закрытого ввода («bye») раньше, чем стартовала новая
	waitFor(t, "строка старта 1.4.0", func() bool { return journalHas(s.home, `"line":"app 1.4.0 start`) })
	b := readJournal(s.home)
	bye, start := strings.Index(b, `"line":"bye"`), strings.Index(b, `"line":"app 1.4.0 start`)
	if bye < 0 || start < 0 || bye > start {
		t.Fatalf("наложение версий: bye=%d start=%d", bye, start)
	}
	if !exists(versionDir(s.home, "capture", "1.3.2")) {
		t.Fatal("предыдущая версия убрана — отката без скачивания не будет")
	}
	waitFor(t, "позапрошлая версия убрана", func() bool { return !exists(versionDir(s.home, "capture", "0.9.0")) })
	es, _ := os.ReadDir(partDir(s.home, "capture"))
	var got []string
	for _, e := range es {
		got = append(got, e.Name())
	}
	if strings.Join(got, " ") != "1.3.2 1.4.0 data" {
		t.Fatalf("папки части: %v", got)
	}
}

// Не выходит по закрытию ввода: stopping без таймера; force — держатель убивает дерево: и останавливаемую (мимо
// очереди), и работающую (план заморозки, «Чего не делаем»: «остановка ждёт выхода, force убивает»).
func TestEtStubbornForce(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("stubborn"), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	off := s.links.part("capture", "1.3.2", appFiles("stubborn"), map[string]any{"on": false})
	s.relay.push(planMsg(2, off))
	waitFor(t, "stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	time.Sleep(time.Second)
	if partOf(k, "capture").State != "stopping" {
		t.Fatal("stopping держится без таймера")
	}
	off["force"] = true
	s.relay.push(planMsg(3, off))
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	// force по работающей части — сразу, без ожидания закрытого ввода
	s.relay.push(planMsg(4, s.links.part("capture", "1.3.2", appFiles("stubborn"), on)))
	waitFor(t, "running снова", func() bool { return partOf(k, "capture").State == "running" })
	s.relay.push(planMsg(5, off))
	waitFor(t, "stopped силой", func() bool { return partOf(k, "capture").State == "stopped" })
	waitFor(t, "два выхода силой", func() bool {
		return strings.Count(readJournal(s.home), `"ev":"part_exit","version":"1.3.2","why":"сигнал SIGKILL`) == 2
	})
}

// Одно падение — один перезапуск, с диска: ссылка из плана живёт час; второе — failed и part.failed; та же запись
// плана failed не трогает (устав, закрытый список: «умерла — один перезапуск, второе падение — failed, дальше решает
// агент (set on:false → on:true)»).
func TestEtOneRestartThenFailed(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	s.links.expire()
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	if !journalHas(s.home, `"kind":"stop","ev":"part_exit","why":"capture 1.3.2 вышла сама`) {
		t.Fatal("нет строки о падении")
	}
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.3.2 — второе падение") })
	// та же запись части с новой rev — keeper failed не трогает: решает тот, кто правит план
	same := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.relay.push(planMsg(2, same))
	time.Sleep(700 * time.Millisecond)
	if partOf(k, "capture").State != "failed" {
		t.Fatal("failed поднят без правки плана")
	}
	// on: false, затем on: true — чистый перезапуск
	off := s.links.part("capture", "1.3.2", appFiles(""), map[string]any{"on": false})
	s.relay.push(planMsg(3, off))
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	s.relay.push(planMsg(4, same))
	waitFor(t, "running снова", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 0 })
}

// Перезагрузка без связи: файл держателя, умершего с машиной, убран; keeper исполняет сохранённый план
// (план заморозки: «хранить на диске и исполнять без связи»; устав, система ловит — строки с причиной).
func TestEtSavedPlanWithoutRelay(t *testing.T) {
	s := newStand(t)
	pl := plan1(7, s.links.part("capture", "1.3.2", appFiles(""), on))
	b, _ := json.Marshal(pl)
	os.WriteFile(planPath(s.home), b, 0o600)
	writeConf(s.home, map[string]any{}) // relay нет
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	writeHoldFile(s.home, holdFile{ID: "capture", Owner: "keeper", Port: port, Key: "dead", Tag: "1.3.2"})
	k := s.start()
	waitFor(t, "running без связи", func() bool { return partOf(k, "capture").State == "running" })
	for _, want := range []string{`"kind":"stop","ev":"relay","why":"в keeper.json нет relay`,
		`"ev":"adopt","id":"capture","why":"держатель не отвечает — файл убран`, `"ev":"plan","rev":7`, `"ev":"part_start","version":"1.3.2","pid":`} {
		if !journalHas(s.home, want) {
			t.Fatalf("нет строки %s", want)
		}
	}
}

// Перезапуск keeper не трогает процессы: новый keeper подключается к держателю, pid тот же, вывод дочитан.
func TestEtKeeperRestartAdopts(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	k.Stop()
	k2 := s.start()
	waitFor(t, "подключился", func() bool { p := partOf(k2, "capture"); return p.State == "running" && p.Pid == pid })
	if partOf(k2, "capture").Version != "1.3.2" {
		t.Fatal("версия держателя потеряна")
	}
}

// Выход без keeper — одно падение: держатель хранит код выхода, новый keeper получает его и поднимает часть.
func TestEtExitWithoutKeeper(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	k.Stop()
	killPid(t, pid)
	time.Sleep(300 * time.Millisecond)
	k2 := s.start()
	waitFor(t, "один перезапуск", func() bool {
		p := partOf(k2, "capture")
		return p.State == "running" && p.Restarts == 1 && p.Pid != pid
	})
}

// keeper отвечает состояние сам, без Host.
func TestEtKeeperState(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	r := s.relay.ask(map[string]any{"type": "keeper.state", "to": ".keeper@win"})
	if r["ok"] != true {
		t.Fatalf("ответ %v", r)
	}
	res := r["result"].(map[string]any)
	if res["keeper"] != keeperVersion || res["rev"].(float64) != 3 || res["os"] == "" {
		t.Fatalf("ответ %v", res)
	}
	ps := res["parts"].([]any)
	if len(ps) != 1 || ps[0].(map[string]any)["state"] != "running" {
		t.Fatalf("части %v", ps)
	}
	if r["to"] != "~test" {
		t.Fatal("ответ не тому, кто спросил")
	}
	// незнакомый запрос — отказ словом (устав: «ошибки — словами»)
	if u := s.relay.ask(map[string]any{"type": "keeper.nope", "to": ".keeper@win"}); u["ok"] != false || u["error"] != "unknown_request" {
		t.Fatalf("ответ на незнакомый запрос %v", u)
	}
}

// Ничей держатель убит: часть не из плана — на старте kill.
func TestEtOrphanHolderKilled(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	f, err := spawnHolder(s.home, holdSpec{ID: "old", Owner: "keeper", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	s.relay.setPlan(plan1(1))
	s.start()
	waitFor(t, "ничей убит", func() bool { return !exists(holdPath(s.home, "old")) })
	waitFor(t, "процесс ничьего держателя умер", func() bool { return !alive(f.Pid) })
	if alive(f.Pid) {
		t.Fatal("процесс ничьего держателя жив")
	}
}

// Держатели Host keeper не трогает: ни подключения, ни снятия (устав: «Процессы claude держит Host через свои держатели»).
func TestEtHostHoldersUntouched(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	f, err := spawnHolder(s.home, holdSpec{ID: "site@win", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "план rev 1", func() bool { return k.state().Rev == 1 })
	time.Sleep(700 * time.Millisecond)
	if !exists(holdPath(s.home, "site@win")) || !alive(f.Pid) {
		t.Fatal("держатель Host тронут")
	}
	if journalHas(s.home, `"ev":"adopt","id":"site@win"`) || journalHas(s.home, `"ev":"orphan_kill","id":"site@win"`) {
		t.Fatal("keeper взялся за держатель Host")
	}
}

// Новое окружение части в плане при той же версии — перезапуск с ним (ревью архитектора 1 нояб.).
func TestEtEnvChangeRestarts(t *testing.T) {
	s := newStand(t)
	part := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.relay.setPlan(plan1(1, part))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	withEnv := map[string]any{}
	for kk, v := range part {
		withEnv[kk] = v
	}
	withEnv["env"] = map[string]string{"SITE": "lab"}
	s.relay.push(planMsg(2, withEnv))
	waitFor(t, "перезапуск с новым окружением", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Pid != 0 && p.Pid != pid })
	s.relay.push(planMsg(3, withEnv))
	time.Sleep(500 * time.Millisecond)
	if p := partOf(k, "capture"); p.Restarts != 0 || p.State != "running" {
		t.Fatalf("тот же план с новой rev тронул часть: %+v", p)
	}
}

// Самообновление: последним шагом плана, где бы ни стояла запись keeper; новый файл ответил своей версией → подмена
// своего файла, part.updated и выход; держатели живут (план заморозки, «Подмена себя»: «По плану, последним шагом;
// держатели живут»).
func TestEtSelfUpdate(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	app := s.links.part("capture", "1.3.2", appFiles(""), on)
	kp := s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, kp, app))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	select {
	case <-k.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	b, _ := os.ReadFile(target)
	if len(b) != len(bin) {
		t.Fatal("файл keeper не подменён")
	}
	if ms, _ := filepath.Glob(target + "." + keeperVersion + ".*.old"); len(ms) != 1 {
		t.Fatalf("старый файл не переименован: %v", ms)
	}
	if f := readHoldFiles(s.home); len(f) != 1 || !alive(f[0].Pid) {
		t.Fatal("держатель приложения не пережил подмену keeper")
	}
	waitFor(t, "part.updated keeper", func() bool { return s.relay.ledgerHas("part.updated keeper " + keeperVersion + " → 9.9.9") })
}

// Новый файл keeper не тот: check_failed, keeper не выходит.
func TestEtSelfUpdateCheckFailed(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "1.0.0")
	kp := s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, kp))
	k := s.start()
	waitFor(t, "check_failed", func() bool { return strings.Contains(partOf(k, "keeper").Error, "check_failed") })
	select {
	case <-k.Done():
		t.Fatal("keeper остановился после check_failed")
	default:
	}
	if !journalHas(s.home, `"ev":"part_failed","why":"keeper 9.9.9: check_failed`) {
		t.Fatal("сбой подмены не в журнале машины")
	}
	// сбой подмены — как у любой части: и в журнале флота (чьё: код, install.go «как у любой части»)
	waitFor(t, "part.failed keeper", func() bool { return s.relay.ledgerHas("part.failed keeper 9.9.9 — check_failed") })
}

/* ===== держатель ===== */

// Держатель копит вывод без хозяина и отдаёт его хозяину; второй хозяин вытесняет первого; чужой ключ — bad_key
// (чьё: код — «Протокол держателя — заморожен», «Подключается к нему только хозяин, по ключу»; план заморозки,
// «Держатель»: «накопление без хозяина»).
func TestEtHolderBufferAndOwner(t *testing.T) {
	// байты кадра — образец замороженного протокола; тот же образец проверяет Host
	var gb bytes.Buffer
	writeFrame(&gb, frAuth, []byte("key"))
	if gb.String() != "a\x00\x00\x00\x03key" {
		t.Fatalf("кадр %q", gb.String())
	}
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "x", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app"}})
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
	c1 := &heldConn{c: raw}
	var first strings.Builder
	firstDone := make(chan error, 1)
	go func() {
		x, err := c1.read(func(b []byte) { first.Write(b) })
		if x != nil {
			err = fmt.Errorf("прежнему хозяину отдан выход %+v", x)
		}
		firstDone <- err
	}()
	c2, hh, err := dialHolder(f)
	if err != nil || hh.Pid != f.Pid {
		t.Fatalf("второй хозяин: %+v %v", hh, err)
	}
	if err := <-firstDone; err == nil || !strings.Contains(first.String(), "app 1 start") {
		t.Fatalf("прежний хозяин не вытеснен или без накопленного: %v %q", err, first.String())
	}
	waitFor(t, "строка held_replaced", func() bool { return journalHas(home, `"ev":"held_replaced"`) })
	bad := f
	bad.Key = "nope"
	if _, _, err := dialHolder(bad); err == nil || !strings.Contains(err.Error(), "bad_key") {
		t.Fatalf("чужой ключ: %v", err)
	}
	// выход процесса — у второго хозяина
	c2.closeInput()
	if x, err := c2.read(func([]byte) {}); err != nil || x == nil {
		t.Fatalf("выход второму хозяину %v %v", x, err)
	}
}

// Умер держатель — умер процесс: ничьих процессов не бывает.
func TestEtHolderDiesChildDies(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "y", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf holdFile
	b, _ := os.ReadFile(holdPath(home, "y"))
	json.Unmarshal(b, &hf)
	killPid(t, hf.Holder)
	waitFor(t, "процесс умер с держателем", func() bool { return !alive(f.Pid) })
}

func readJournal(home string) string {
	ms, _ := filepath.Glob(filepath.Join(home, "journal", "keeper-*.jsonl"))
	var s strings.Builder
	for _, m := range ms {
		b, _ := os.ReadFile(m)
		s.Write(b)
	}
	return s.String()
}

// npm из app.json — npm-cli.js рядом с Node из keeper.json под тем же Node: на Windows npm — это npm.cmd,
// а у службы может не быть PATH (чьё: дизайн «npm — npm рядом с ним»).
func TestNpmNextToNode(t *testing.T) {
	d := t.TempDir()
	node := filepath.Join(d, exeName("node"))
	cli := filepath.Join(d, "node_modules", "npm", "bin", "npm-cli.js")
	os.MkdirAll(filepath.Dir(cli), 0o755)
	os.WriteFile(node, nil, 0o755)
	os.WriteFile(cli, nil, 0o644)
	k := &Keeper{node: node}
	got := k.command([]string{"npm", "ci", "--omit=dev"}, d)
	if strings.Join(got, "|") != strings.Join([]string{node, cli, "ci", "--omit=dev"}, "|") {
		t.Fatalf("команда %v", got)
	}
	if got := (&Keeper{}).command([]string{"npm", "ci"}, d); got[0] != "npm" {
		t.Fatalf("без node в keeper.json — npm как есть: %v", got)
	}
}

// setup — в папке версии, а не во временной: npm на Windows связывает пакеты workspaces ссылками с полным путём,
// после переименования временной папки Host не находил свои пакеты (живой прогон 1 нояб., win: ERR_MODULE_NOT_FOUND).
func TestSetupInVersionDir(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	app := appFiles("")
	b, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "setup"}})
	app["app.json"] = string(b)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", app, on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	dir := versionDir(s.home, "capture", "1.3.2")
	got, _ := os.ReadFile(filepath.Join(dir, "setup-dir"))
	a, _ := os.Stat(string(got))
	d, _ := os.Stat(dir)
	if a == nil || d == nil || !os.SameFile(a, d) {
		t.Fatalf("setup шёл в %q, а версия в %q", got, dir)
	}
}

/* ===== заморозка 1.0.0: ветки, которые закрепил харденинг ===== */

// Кадр плана отклонён: не от .releases — bad_from; замороженный keeper не исполняет того, чего не знает: чужое поле
// части или v≠1 у кадра — contract_mismatch; план и части не тронуты (план заморозки, контракт «план машины v1»:
// «чужое поле или v≠1 — отказ»; эталон «План не от «выпусков» не исполняется»).
func TestEtPlanContractMismatch(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "план rev 1", func() bool { return k.state().Rev == 1 })
	foreign := planMsg(5, s.links.part("capture", "1.0.0", appFiles(""), on))
	foreign["from"] = "phone~x@y"
	s.relay.push(foreign)
	extra := s.links.part("capture", "1.0.0", appFiles(""), on)
	extra["args"] = []string{"--x"}
	s.relay.push(planMsg(2, extra))
	v2 := planMsg(3, s.links.part("capture", "1.0.0", appFiles(""), on))
	v2["v"] = 2
	s.relay.push(v2)
	waitFor(t, "три отказа", func() bool {
		j := readJournal(s.home)
		return strings.Count(j, `"word":"contract_mismatch"`) == 2 && strings.Count(j, `"word":"bad_from"`) == 1
	})
	time.Sleep(300 * time.Millisecond)
	if k.state().Rev != 1 || partOf(k, "capture").State != "" {
		t.Fatalf("отклонённый план исполнен: %+v", k.state())
	}
}

// План старше исполняемого не исполняется — строка refuse old_rev; та же rev при переподключении — без строки.
func TestEtPlanOldRev(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(5))
	k := s.start()
	waitFor(t, "rev 5", func() bool { return k.state().Rev == 5 })
	s.relay.drop()
	waitFor(t, "вопрос после переподключения", func() bool { return s.relay.planAsks() == 2 })
	time.Sleep(500 * time.Millisecond)
	s.relay.push(planMsg(3, s.links.part("capture", "1.0.0", appFiles(""), on)))
	waitFor(t, "old_rev", func() bool { return journalHas(s.home, `"word":"old_rev"`) })
	if n := strings.Count(readJournal(s.home), `"word":"old_rev"`); n != 1 || k.state().Rev != 5 || partOf(k, "capture").State != "" {
		t.Fatalf("строк old_rev %d, rev %d", n, k.state().Rev)
	}
}

// Битый plan.json — строка stop с причиной; keeper живёт и берёт план у «выпусков».
func TestEtBrokenPlanFile(t *testing.T) {
	s := newStand(t)
	os.WriteFile(planPath(s.home), []byte("{битый"), 0o600)
	s.relay.setPlan(plan1(2, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	if r := journalLine(s.home, `"ev":"plan","why":"plan.json`); r == nil || r["kind"] != "stop" {
		t.Fatalf("строка о битом plan.json: %v", r)
	}
	waitFor(t, "план от «выпусков»", func() bool { return partOf(k, "capture").State == "running" })
}

// Старая версия упала, пока ставится новая: работает один экземпляр новой версии, перезапусков 0
// (ревью 1 нояб.: было два экземпляра).
func TestEtCrashDuringInstall(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	old := partOf(k, "capture").Pid
	self, _ := os.Executable()
	app := appFiles("")
	b, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "slowsetup"}})
	app["app.json"] = string(b)
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", app, on)))
	waitFor(t, "setup идёт", func() bool { return exists(filepath.Join(versionDir(s.home, "capture", "1.4.0"), "setup-started")) })
	killPid(t, old)
	waitFor(t, "1.4.0 running", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.4.0" })
	time.Sleep(time.Second) // выход старой версии разобран
	starts := strings.Count(readJournal(s.home), `"ev":"part_start","version":"1.4.0"`)
	if p := partOf(k, "capture"); starts != 1 || p.Restarts != 0 || p.State != "running" {
		t.Fatalf("стартов 1.4.0: %d, %+v", starts, p)
	}
}

// Упрямая часть останавливается — keeper ждёт её со всем остальным: упавшая другая часть ждёт в exited;
// force по первой пускает перезапуск второй (дизайн: план исполняется после выхода).
func TestEtStubbornHoldsRestartUntilForce(t *testing.T) {
	s := newStand(t)
	a := s.links.part("capture", "1.3.2", appFiles("stubborn"), on)
	b := s.links.part("probe", "1.0.0", appFiles(""), on)
	s.relay.setPlan(plan1(1, a, b))
	k := s.start()
	waitFor(t, "обе running", func() bool { return partOf(k, "capture").State == "running" && partOf(k, "probe").State == "running" })
	off := s.links.part("capture", "1.3.2", appFiles("stubborn"), map[string]any{"on": false})
	s.relay.push(planMsg(2, off, b))
	waitFor(t, "capture stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	killPid(t, partOf(k, "probe").Pid)
	waitFor(t, "probe exited", func() bool { return partOf(k, "probe").State == "exited" })
	off["force"] = true
	s.relay.push(planMsg(3, off, b))
	waitFor(t, "probe перезапущена", func() bool { p := partOf(k, "probe"); return p.State == "running" && p.Restarts == 1 })
	if st := partOf(k, "capture").State; st != "stopped" {
		t.Fatalf("capture %s", st)
	}
}

// Сбой установки части, которая ещё не работает: failed со словом и part.failed в журнале флота — хэш не сошёлся,
// в архиве не файл и не папка, app.json с чужим полем, setup упал (тогда папки версии нет) (план заморозки: находки
// «Сбой установки части не доходит до журнала флота», «архив со ссылкой → download_failed», «чужое поле в app.json —
// отказ этой части»; устав, система ловит).
func TestEtInstallFailedToLedger(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bad := s.links.part("capture", "1.0.0", appFiles(""), on)
	bad["sha256"] = strings.Repeat("0", 64)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	b, _ := json.Marshal(map[string]any{"run": []string{"x"}})
	tw.WriteHeader(&tar.Header{Name: "app.json", Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg})
	tw.Write(b)
	tw.WriteHeader(&tar.Header{Name: "link", Linkname: "app.json", Typeflag: tar.TypeSymlink})
	tw.Close()
	zw.Close()
	link := s.links.partTgz("probe", "1.0.0", buf.Bytes(), on)
	foreign := appFiles("")
	foreign["app.json"] = `{"run":["x"],"user":"admin"}`
	setup := appFiles("")
	sb, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "badsetup"}})
	setup["app.json"] = string(sb)
	s.relay.setPlan(plan1(1, bad, link, s.links.part("meter", "1.0.0", foreign, on), s.links.part("web", "1.0.0", setup, on)))
	k := s.start()
	for _, c := range []struct{ part, word string }{{"capture", "download_failed"}, {"probe", "download_failed"},
		{"meter", "contract_mismatch"}, {"web", "setup_failed"}} {
		waitFor(t, c.part+" failed "+c.word, func() bool { p := partOf(k, c.part); return p.State == "failed" && strings.Contains(p.Error, c.word) })
		waitFor(t, "part.failed "+c.part, func() bool { return s.relay.ledgerHas("part.failed " + c.part + " 1.0.0 — " + c.word) })
	}
	if !strings.Contains(partOf(k, "probe").Error, "только файлы и папки") || !strings.Contains(partOf(k, "web").Error, "npm ERR! нет пакета") {
		t.Fatalf("причины: %q · %q", partOf(k, "probe").Error, partOf(k, "web").Error)
	}
	if exists(versionDir(s.home, "web", "1.0.0")) {
		t.Fatal("папка версии с упавшим setup осталась")
	}
}

// Часть убрана из плана: остановлена штатно и снята из keeper.state, папки версий убраны, data/ осталась.
func TestEtPartRemoved(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	keep := filepath.Join(partDir(s.home, "capture"), "data", "keep")
	os.WriteFile(keep, []byte("1"), 0o600)
	s.relay.push(planMsg(2))
	waitFor(t, "снята", func() bool { return len(k.state().Parts) == 0 })
	// папки версий keeper убирает после того, как снял часть из keeper.state
	waitFor(t, "папка версии убрана", func() bool { return !exists(versionDir(s.home, "capture", "1.3.2")) })
	if !exists(keep) {
		t.Fatal("data/ убрана")
	}
	if !journalHas(s.home, `"line":"bye"`) {
		t.Fatal("часть не остановлена закрытием ввода")
	}
}

// Приложение получает от keeper окружение машины и окружение из плана.
func TestEtPartEnv(t *testing.T) {
	s := newStand(t)
	p := s.links.part("capture", "1.3.2", appFiles("env"), on)
	p["env"] = map[string]string{"SITE": "lab"}
	s.relay.setPlan(plan1(1, p))
	s.start()
	waitFor(t, "строка env", func() bool { return journalHas(s.home, `"line":"env `) })
	line, _ := journalLine(s.home, `"line":"env `)["line"].(string)
	self, _ := os.Executable()
	data := filepath.Join(partDir(s.home, "capture"), "data")
	for _, want := range []string{"SWITCHBOARD_MACHINE=win", "SWITCHBOARD_VERSION=1.3.2", "SWITCHBOARD_DATA=" + data,
		"SWITCHBOARD_HOLDER=" + self, "SWITCHBOARD_RELAY=" + s.relay.url(), "SITE=lab"} {
		if !strings.Contains(line, want) {
			t.Fatalf("нет %s в %q", want, line)
		}
	}
}

// Процесс не читает ввод: 256 КБ ввода и «убей» — процесс снят меньше чем за секунду, хозяин получил выход SIGKILL
// (план заморозки, находка «Убей»; опыт 1 нояб. на 0.5.6: от 8 КБ процесс жив через 8 с).
func TestEtHolderKillBehindInput(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "d", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app", "deaf"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	go func() {
		chunk := make([]byte, 32*1024)
		for i := 0; i < 8; i++ {
			if c.send(frInput, chunk) != nil {
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
	t.Logf("снят через %v", d)
	if d > time.Second {
		t.Fatalf("снят через %v", d)
	}
	waitFor(t, "процесс снят", func() bool { return !alive(f.Pid) })
}

// После подмены себя версии keeper на диске — новая и та, с которой ушли: прежний файл для отката лежит рядом
// (машины 1 нояб.: 6 версий, 77 МБ).
func TestEtSelfUpdateCleansVersions(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	for _, v := range []string{"0.0.1", keeperVersion} {
		os.MkdirAll(versionDir(s.home, "keeper", v), 0o700)
	}
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	select {
	case <-k.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	es, _ := os.ReadDir(partDir(s.home, "keeper"))
	var got []string
	for _, e := range es {
		got = append(got, e.Name())
	}
	if strings.Join(got, " ") != keeperVersion+" 9.9.9" {
		t.Fatalf("версии keeper: %v", got)
	}
}

// Остановка keeper, пока ставится новая версия: работающая живёт дальше с тем же pid, переход — у следующего keeper
// (ревью архитектора 1 нояб.: цикл доводил установку и гасил прежнюю версию).
func TestEtStopDuringInstallKeepsRunning(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	self, _ := os.Executable()
	app := appFiles("")
	b, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "slowsetup"}})
	app["app.json"] = string(b)
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", app, on)))
	waitFor(t, "setup идёт", func() bool { return exists(filepath.Join(versionDir(s.home, "capture", "1.4.0"), "setup-started")) })
	k.Stop()
	if !alive(pid) || journalHas(s.home, `"line":"bye"`) {
		t.Fatal("работающая версия остановлена вместе с keeper")
	}
	k2 := s.start()
	waitFor(t, "переход у следующего keeper", func() bool {
		p := partOf(k2, "capture")
		return p.State == "running" && p.Version == "1.4.0" && p.Restarts == 0
	})
}

// Прежний файл keeper с тем же именем ещё занят (откат и новая выкладка, держатель прошлой эпохи) — подмена себя
// проходит (ревью 1 нояб.: Access is denied на Windows).
func TestEtSelfUpdateOldNameBusy(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	busy := target + "." + keeperVersion + ".old"
	os.WriteFile(busy, []byte("epoch 1"), 0o755)
	h, err := os.Open(busy)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	select {
	case <-k.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	if b, _ := os.ReadFile(target); len(b) != len(bin) {
		t.Fatal("файл keeper не подменён")
	}
}

// Штатная остановка: keeper дописал своё — keeper_exit последняя его строка в журнале, после Stop он не пишет;
// держатель и процесс части живут (находка пользователя 1 нояб.: CI на ubuntu — «journal: directory not empty» при
// уборке после Stop; устав: штатная остановка, «держатели живут»).
func TestEtStopLastLine(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("chatty"), on)))
	k := s.start()
	waitFor(t, "вывод идёт", func() bool { return journalHas(s.home, `"line":"tick 20"`) })
	pid := partOf(k, "capture").Pid
	k.Stop()
	if !alive(pid) || !exists(holdPath(s.home, "capture")) {
		t.Fatal("остановка keeper остановила часть")
	}
	time.Sleep(300 * time.Millisecond)
	var last map[string]any
	for _, l := range strings.Split(readJournal(s.home), "\n") {
		var r map[string]any
		if json.Unmarshal([]byte(l), &r) == nil && r["who"] == "keeper" {
			last = r
		}
	}
	if last["ev"] != "keeper_exit" {
		t.Fatalf("последняя строка keeper после остановки: %v", last)
	}
}

// Откат после неудачной подмены: план с работающей версией keeper снимает failed keeper из keeper.state.
func TestEtKeeperRollbackClearsFailed(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "0.0.0-wrong")
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)))
	k := s.start()
	waitFor(t, "check_failed", func() bool { return strings.Contains(partOf(k, "keeper").Error, "check_failed") })
	s.relay.push(planMsg(2, s.links.part("keeper", keeperVersion, files{"x": "x"}, nil)))
	waitFor(t, "failed снят", func() bool { return partOf(k, "keeper").State == "" })
}

// failed живёт до перезапуска keeper: новый keeper снова запускает часть и даёт ей один перезапуск
// (решение плана заморозки 1 нояб., чьё: код).
func TestEtFailedUntilKeeperRestart(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	k.Stop()
	k2 := s.start()
	waitFor(t, "снова running", func() bool { p := partOf(k2, "capture"); return p.State == "running" && p.Restarts == 0 })
}

// Обрыв связи с relay — keeper переподключается и спрашивает план снова.
func TestEtRelayDropReasks(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	s.start()
	waitFor(t, "первый вопрос", func() bool { return s.relay.planAsks() == 1 })
	s.relay.drop()
	waitFor(t, "вопрос после переподключения", func() bool { return s.relay.planAsks() == 2 })
}

// «Выпуски» не ответили на вопрос о плане — keeper закрывает соединение, переподключается и спрашивает снова.
func TestEtPlanNoAnswerReconnects(t *testing.T) {
	s := newStand(t)
	s.relay.setSilent(1)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.startWith(func(k *Keeper) { k.planWait = 500 * time.Millisecond })
	waitFor(t, "план со второго вопроса", func() bool { return partOf(k, "capture").State == "running" })
	if s.relay.planAsks() < 2 || !journalHas(s.home, `"word":"timeout"`) {
		t.Fatalf("вопросов %d", s.relay.planAsks())
	}
}

/* ===== план тестов 1 нояб.: сценарии, у которых не было эталона ===== */

// После подмены себя прежние файлы keeper — с версией и pid и от установки — убраны на старте тем же шаблоном
// (план заморозки, находка «Подмена себя после отката»: «Уборка на старте находит их тем же шаблоном»).
func TestEtOldSelfCleanedOnStart(t *testing.T) {
	s := newStand(t)
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("cur"), 0o755)
	olds := []string{target + ".0.9.0.4242.old", target + ".prev.77.old"}
	for _, o := range olds {
		os.WriteFile(o, []byte("old"), 0o755)
	}
	s.relay.setPlan(plan1(1))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	waitFor(t, "план rev 1", func() bool { return k.state().Rev == 1 })
	for _, o := range olds {
		if exists(o) {
			t.Fatalf("прежний файл не убран: %s", o)
		}
	}
	if !exists(target) {
		t.Fatal("убран сам файл keeper")
	}
}

// Остановка keeper, пока упрямая прежняя версия выходит при смене версии: keeper не ждёт её и выходит с keeper_exit,
// новую версию не запускает — иначе две версии разом; прежняя живёт до force (чьё: код — «Остановка keeper прерывает
// ожидание»; устав: штатная остановка).
func TestEtStopDuringStubbornSwitch(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("stubborn"), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles("stubborn"), on)))
	waitFor(t, "1.3.2 stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	start := time.Now()
	k.Stop()
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("остановка ждала упрямую часть %v", d)
	}
	if !journalHas(s.home, `"ev":"keeper_exit"`) || !alive(pid) || journalHas(s.home, `"ev":"part_start","version":"1.4.0"`) {
		t.Fatal("нет keeper_exit, прежняя версия снята или новая запущена")
	}
}

// «Выпуски» ответили на вопрос о плане отказом — строка refuse со словом, исполняется сохранённый план, соединение не
// рвётся: переспрашивает только молчание (устав: система ловит, «ошибки — словами»; чьё: код — askPlan).
func TestEtPlanReplyRefused(t *testing.T) {
	s := newStand(t)
	b, _ := json.Marshal(plan1(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
	os.WriteFile(planPath(s.home), b, 0o600)
	s.relay.setRefuse("cf_failed")
	k := s.start()
	waitFor(t, "строка отказа", func() bool { return journalHas(s.home, `"kind":"refuse","ev":"plan","word":"cf_failed"`) })
	waitFor(t, "сохранённый план", func() bool { return partOf(k, "capture").State == "running" })
	time.Sleep(700 * time.Millisecond)
	if k.state().Rev != 3 || s.relay.planAsks() != 1 {
		t.Fatalf("rev %d, вопросов %d", k.state().Rev, s.relay.planAsks())
	}
}

// Связь с relay: relay недоступен — keeper повторяет подключение, пока тот не поднимется; принял hello, но на ping
// молчит — соединение мёртвое: keeper закрывает его и подключается снова (устав, закрытый список: «соединение…
// оборвалось — клиенты переподключаются»; факт: сеть WSL теряет пакеты; чьё: код — «нет pong к следующему —
// соединение мёртвое»).
func TestEtRelayReconnects(t *testing.T) {
	var mu sync.Mutex
	tries, hellos := 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		tries++
		n := tries
		mu.Unlock()
		if n <= 3 {
			w.WriteHeader(http.StatusServiceUnavailable) // relay ещё не поднялся
			return
		}
		ws, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		ctx := context.Background()
		if _, _, err := ws.Read(ctx); err != nil {
			return
		}
		mu.Lock()
		hellos++
		mu.Unlock()
		ws.Write(ctx, websocket.MessageText, []byte(`{"type":"roster"}`))
		for {
			if _, _, err := ws.Read(ctx); err != nil { // ping читается, pong не уходит
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	r := newRadio("ws"+strings.TrimPrefix(srv.URL, "http"), "host.win.ab12.sig")
	r.pingMs, r.pause0, r.pauseMax = 100*time.Millisecond, 20*time.Millisecond, 80*time.Millisecond
	var whys []string
	r.onState = func(open bool, why string) {
		if !open {
			mu.Lock()
			whys = append(whys, why)
			mu.Unlock()
		}
	}
	go r.run()
	t.Cleanup(r.close)
	waitFor(t, "второе подключение после молчания на ping", func() bool { mu.Lock(); defer mu.Unlock(); return hellos >= 2 })
	mu.Lock()
	defer mu.Unlock()
	dial := 0
	for _, w := range whys {
		if strings.HasPrefix(w, "dial: ") {
			dial++
		}
	}
	if dial != 3 {
		t.Fatalf("неудачных подключений %d: %q", dial, whys)
	}
}

// Выключить — ввод закрыт, процесс вышел штатно, stopped; включить — снова с диска, без скачивания: ссылка из плана
// живёт час (план заморозки, «Жизнь части»: «остановка закрытием ввода»; «Установка версии»: «отметить папку»;
// чьё: код — «уже стоит из того же архива — без скачивания»).
func TestEtPartOffOn(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	off := s.links.part("capture", "1.3.2", appFiles(""), map[string]any{"on": false})
	back := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.links.expire()
	s.relay.push(planMsg(2, off))
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	if !journalHas(s.home, `"line":"bye"`) {
		t.Fatal("часть не остановлена закрытием ввода")
	}
	waitFor(t, "процесс вышел", func() bool { return !alive(pid) })
	s.relay.push(planMsg(3, back))
	waitFor(t, "running снова", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Pid != pid && p.Restarts == 0 })
	if n := strings.Count(readJournal(s.home), `"ev":"installed"`); n != 1 {
		t.Fatalf("установок %d — включение скачивало", n)
	}
}

// Команды run нет на машине — держатель не запустил её: часть failed с причиной «запуск: …» и part.failed в журнале
// флота (устав: система ловит; чьё: код).
func TestEtRunFailsToStart(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.0.0", files{"app.json": `{"run":["switchboard-no-such-program"]}`}, on)))
	k := s.start()
	waitFor(t, "failed", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.HasPrefix(p.Error, "запуск: ")
	})
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.0.0 — запуск: ") })
}

// Умер держатель части — связь с ним оборвалась без кадра выхода: это падение части, один перезапуск с причиной
// «связь с держателем оборвалась»; процесс ушёл вместе с держателем (устав, закрытый список: «умерла — один перезапуск»).
func TestEtHolderDiedPartRestarts(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	var hf holdFile
	b, _ := os.ReadFile(holdPath(s.home, "capture"))
	json.Unmarshal(b, &hf)
	killPid(t, hf.Holder)
	waitFor(t, "один перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 && p.Pid != pid })
	if !journalHas(s.home, `"ev":"part_exit","why":"capture 1.3.2 вышла сама: связь с держателем оборвалась`) {
		t.Fatal("нет строки о падении с причиной обрыва")
	}
	waitFor(t, "прежний процесс мёртв", func() bool { return !alive(pid) })
}

// Держатель запустил процесс: хозяину — порт, ключ и pid строкой о себе, то же — в файле procs/<id>.json; строки
// держателя — под тем, чей процесс он держит: часть машины — её именем, сессия Host — host и callsign (чьё: код —
// hold.go «пишет о себе … procs/<id>.json … и одной строкой то же — в свой stdout», «строки держателя — под тем, чей
// процесс он держит»).
func TestEtHolderJournalOwner(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	fp, err := spawnHolder(home, holdSpec{ID: "capture", Owner: "keeper", Tag: "1.3.2", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1.3.2"), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	fh, err := spawnHolder(home, holdSpec{ID: "site@win", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []holdFile{fp, fh} {
		var disk holdFile
		b, _ := os.ReadFile(holdPath(home, f.ID))
		json.Unmarshal(b, &disk)
		if f.Port == 0 || len(f.Key) != 64 || !alive(f.Pid) || disk.Port != f.Port || disk.Key != f.Key || disk.Pid != f.Pid || disk.Owner != f.Owner {
			t.Fatalf("о себе %+v, в файле %+v", f, disk)
		}
	}
	waitFor(t, "stderr части в журнале", func() bool { return journalHas(home, `"id":"capture","line":"app: stderr line"`) })
	if r := journalLine(home, `"id":"capture","line":"app: stderr line"`); r["part"] != "capture" || r["who"] != "holder" {
		t.Fatalf("строка держателя части %v", r)
	}
	if r := journalLine(home, `"ev":"hold","callsign":"site@win"`); r["part"] != "host" || r["who"] != "holder" {
		t.Fatalf("строка держателя сессии %v", r)
	}
}

// Держатель не запустил команду — хозяин получает отказ «держатель не запустился: …», в журнале — hold_failed с
// причиной, файла о держателе нет (устав: система ловит).
func TestEtHoldRefused(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	_, err := spawnHolder(home, holdSpec{ID: "z", Owner: "host", Env: os.Environ(), Cmd: []string{"switchboard-no-such-program"}})
	if err == nil || !strings.Contains(err.Error(), "держатель не запустился") {
		t.Fatalf("отказ хозяину: %v", err)
	}
	if r := journalLine(home, `"ev":"hold_failed"`); r == nil || r["kind"] != "stop" || r["why"] == "" || r["why"] == nil {
		t.Fatalf("строка hold_failed %v", r)
	}
	if exists(holdPath(home, "z")) {
		t.Fatal("файл держателя остался")
	}
}

// Ввод доходит до процесса по порядку, «закрой ввод» — после всего ввода из очереди; процесс вышел кодом 0
// (план заморозки, «Держатель»: «процесс, его ввод и вывод… Им же пользуется Host для сессий»; находка «Убей»:
// «„Закрой ввод“ встаёт в очередь за вводом»).
func TestEtHolderInputInOrder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "e", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app", "echo"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range []string{"a\n", "b\n", "c\n"} {
		c.send(frInput, []byte(l))
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

// Хозяин ушёл — процесс живёт и пишет, держатель копит вывод; новый хозяин получает тот же pid и накопленное
// (план заморозки, «Держатель»: «накопление без хозяина»; устав, закрытый список: «держатели живут»).
func TestEtHolderOwnerLeftBuffers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "w", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app", "chatty"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	go c.read(func([]byte) {})
	time.Sleep(200 * time.Millisecond)
	c.Close()
	time.Sleep(300 * time.Millisecond)
	c2, hh, err := dialHolder(f)
	if err != nil || hh.Pid != f.Pid || hh.Buffered == 0 {
		t.Fatalf("новый хозяин: %+v %v", hh, err)
	}
	first := make(chan string, 1)
	go c2.read(func(b []byte) {
		select {
		case first <- string(b):
		default:
		}
	})
	select {
	case s := <-first:
		if !strings.Contains(s, "tick") {
			t.Fatalf("накопленное %q", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("накопленное не отдано")
	}
}

// Процесс вышел: держатель снимает его потомков (иначе они держали бы трубу вывода), отдаёт хозяину кадр выхода с
// кодом и последней строкой stderr после всего вывода, убирает свой файл и выходит (чьё: код — hold.go «Процесс вышел
// и выход отдан хозяину — файл убран, держатель вышел», «процесс вышел — его дети в задании тоже»).
func TestEtHolderExitKillsDescendants(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "p", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app", "parent"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf holdFile
	b, _ := os.ReadFile(holdPath(home, "p"))
	json.Unmarshal(b, &hf)
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var out strings.Builder
	type res struct {
		x   *exitInfoJSON
		err error
	}
	done := make(chan res, 1)
	go func() {
		x, err := c.read(func(b []byte) { mu.Lock(); out.Write(b); mu.Unlock() })
		done <- res{x, err}
	}()
	child := 0
	waitFor(t, "потомок запущен", func() bool {
		mu.Lock()
		o := out.String()
		mu.Unlock()
		i := strings.Index(o, "child ")
		if i < 0 || !strings.Contains(o[i:], "\n") {
			return false
		}
		n, _ := fmt.Sscanf(o[i:], "child %d", &child)
		return n == 1
	})
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
	mu.Lock()
	o := out.String()
	mu.Unlock()
	if !strings.Contains(o, "bye") {
		t.Fatalf("вывод до выхода %q", o)
	}
	waitFor(t, "потомок снят", func() bool { return !alive(child) })
	waitFor(t, "файл держателя убран", func() bool { return !exists(holdPath(home, "p")) })
	waitFor(t, "держатель вышел", func() bool { return !alive(hf.Holder) })
}

// Процесс вышел без хозяина — держатель жив, его файл на месте, выход хранится; хозяин пришёл — получает накопленный
// вывод и кадр выхода убитого процесса, затем файл убран и держатель вышел (чьё: код — hold.go «Пока хозяина нет —
// копит вывод и код выхода»).
func TestEtHolderKeepsExitForOwner(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "k", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf holdFile
	b, _ := os.ReadFile(holdPath(home, "k"))
	json.Unmarshal(b, &hf)
	time.Sleep(500 * time.Millisecond) // строка о старте написана
	killPid(t, f.Pid)
	waitFor(t, "процесс убит", func() bool { return !alive(f.Pid) })
	time.Sleep(500 * time.Millisecond)
	if !exists(holdPath(home, "k")) || !alive(hf.Holder) {
		t.Fatal("держатель не дождался хозяина")
	}
	c, hh, err := dialHolder(f)
	if err != nil || hh.Pid != f.Pid {
		t.Fatalf("хозяин: %+v %v", hh, err)
	}
	var out strings.Builder
	x, err := c.read(func(b []byte) { out.Write(b) })
	killed := x != nil && ((x.Code != nil && *x.Code == 3) || (x.Signal != nil && *x.Signal == "SIGKILL"))
	if err != nil || !killed || !strings.Contains(out.String(), "app 1 start") {
		t.Fatalf("выход %+v %v, вывод %q", x, err, out.String())
	}
	waitFor(t, "файл держателя убран", func() bool { return !exists(holdPath(home, "k")) })
	waitFor(t, "держатель вышел", func() bool { return !alive(hf.Holder) })
}
