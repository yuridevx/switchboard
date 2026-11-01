package main

// Эталоны keeper — исполнителя плана, и держателя. Источники свойств — дизайн «Выпуски флота» (слово пользователя
// 1 нояб.: состояние машины спускается сверху, keeper исполняет и отвечает состояние, держатели) и замеры 1 нояб.
import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var on = map[string]any{"on": true}

// Поставить по плану: архив скачан по ссылке, хэш сверен, держатель запускает run из app.json в папке data/.
func TestEtPlanInstallAndRun(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "capture running", func() bool { return partOf(k, "capture").State == "running" })
	p := partOf(k, "capture")
	if p.Version != "1.3.2" || p.Pid == 0 {
		t.Fatalf("state %+v", p)
	}
	if !exists(filepath.Join(s.home, "parts", "capture", "data")) || !exists(filepath.Join(s.home, "parts", "capture", "1.3.2", "release.sha256")) {
		t.Fatal("нет папки версии или data/")
	}
	waitFor(t, "вывод в журнале", func() bool { return journalHas(s.home, `"line":"app 1.3.2 start`) })
	waitFor(t, "stderr держателя в журнале", func() bool { return journalHas(s.home, `app: stderr line`) })
	// строки держателя части — под её именем: их отдаёт log по части (ревью архитектора 1 нояб.)
	if r := journalLine(s.home, `app: stderr line`); r["part"] != "capture" || r["who"] != "holder" {
		t.Fatalf("строка stderr %v", r)
	}
	if _, err := os.Stat(planPath(s.home)); err != nil {
		t.Fatal("план не сохранён на диск")
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

// Смена версии без наложения: новая стартует после выхода старой; part.updated; предыдущая папка остаётся.
func TestEtVersionSwitchNoOverlap(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
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
}

// Плохой план не от .releases не исполняется.
func TestEtPlanOnlyFromReleases(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	k := s.start()
	<-s.relay.opened
	s.relay.push(map[string]any{"type": "releases.plan", "from": "phone~x@y", "rev": 5, "parts": []any{s.links.part("capture", "1.0.0", appFiles(""), on)}})
	time.Sleep(500 * time.Millisecond)
	if partOf(k, "capture").State != "" {
		t.Fatal("план не от .releases исполнен")
	}
}

// Не выходит по закрытию ввода: stopping без таймера; force — держатель убивает дерево.
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
}

// Одно падение — один перезапуск; второе — failed и part.failed; та же запись плана failed не трогает.
func TestEtOneRestartThenFailed(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.3.2") })
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

// Перезагрузка без связи: keeper исполняет сохранённый план.
func TestEtSavedPlanWithoutRelay(t *testing.T) {
	s := newStand(t)
	pl := plan1(7, s.links.part("capture", "1.3.2", appFiles(""), on))
	b, _ := json.Marshal(pl)
	os.WriteFile(planPath(s.home), b, 0o600)
	writeConf(s.home, map[string]any{}) // relay нет
	k := s.start()
	waitFor(t, "running без связи", func() bool { return partOf(k, "capture").State == "running" })
	if k.state().Rev != 7 {
		t.Fatal("rev сохранённого плана")
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

// Держатели Host keeper не трогает.
func TestEtHostHoldersUntouched(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	f, err := spawnHolder(s.home, holdSpec{ID: "site@win", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	s.relay.setPlan(plan1(1))
	s.start()
	time.Sleep(700 * time.Millisecond)
	if !exists(holdPath(s.home, "site@win")) || !alive(f.Pid) {
		t.Fatal("держатель Host тронут")
	}
	// строки держателя сессии — под host и с callsign: их находит отбор по сессии
	if r := journalLine(s.home, "\"ev\":\"hold\""); r["part"] != "host" || r["callsign"] != "site@win" {
		t.Fatalf("строка держателя сессии %v", r)
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

// Самообновление: новый файл ответил своей версией → подмена своего файла и выход; держатели живут.
func TestEtSelfUpdate(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	app := s.links.part("capture", "1.3.2", appFiles(""), on)
	kp := s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, app, kp))
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
}

/* ===== держатель ===== */

// Держатель копит вывод без хозяина и отдаёт его хозяину; второй хозяин вытесняет первого; чужой ключ — bad_key.
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
	c, hh, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	if hh.Buffered == 0 || hh.Pid != f.Pid {
		t.Fatalf("hello %+v", hh)
	}
	var first strings.Builder
	firstDone := make(chan error, 1)
	go func() {
		x, err := c.read(func(b []byte) { first.Write(b) })
		if x != nil {
			err = fmt.Errorf("прежнему хозяину отдан выход %+v", x)
		}
		firstDone <- err
	}()
	c, _, err = dialHolder(f)
	if err != nil {
		t.Fatalf("второй хозяин: %v", err)
	}
	if err := <-firstDone; err == nil || !strings.Contains(first.String(), "app 1 start") {
		t.Fatalf("прежний хозяин не вытеснен или без накопленного: %v %q", err, first.String())
	}
	bad := f
	bad.Key = "nope"
	if _, _, err := dialHolder(bad); err == nil || !strings.Contains(err.Error(), "bad_key") {
		t.Fatalf("чужой ключ: %v", err)
	}
	var out strings.Builder
	c.closeInput()
	x, err := c.read(func(b []byte) { out.Write(b) })
	if err != nil || x == nil || x.Code == nil || *x.Code != 0 {
		t.Fatalf("выход %v %v", x, err)
	}
	if !strings.Contains(out.String(), "bye") {
		t.Fatalf("вывод %q", out.String())
	}
	waitFor(t, "файл держателя убран", func() bool { return !exists(holdPath(home, "x")) })
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

// Замороженный keeper не исполняет того, чего не знает: чужое поле части или v≠1 у кадра — отказ contract_mismatch,
// части не тронуты; чужое поле app.json — отказ этой части.
func TestEtPlanContractMismatch(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "план rev 1", func() bool { return k.state().Rev == 1 })
	extra := s.links.part("capture", "1.0.0", appFiles(""), on)
	extra["args"] = []string{"--x"}
	s.relay.push(planMsg(2, extra))
	v2 := planMsg(3, s.links.part("capture", "1.0.0", appFiles(""), on))
	v2["v"] = 2
	s.relay.push(v2)
	waitFor(t, "два отказа", func() bool { return strings.Count(readJournal(s.home), `"word":"contract_mismatch"`) == 2 })
	if k.state().Rev != 1 || partOf(k, "capture").State != "" {
		t.Fatalf("план не v1 исполнен: %+v", k.state())
	}
	app := appFiles("")
	app["app.json"] = `{"run":["x"],"user":"admin"}`
	s.relay.push(planMsg(4, s.links.part("capture", "1.0.0", app, on)))
	waitFor(t, "часть с чужим app.json — failed", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.Contains(p.Error, "contract_mismatch")
	})
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

// Сбой установки части, которая ещё не работает: failed и part.failed в журнале флота.
func TestEtInstallFailedToLedger(t *testing.T) {
	s := newStand(t)
	bad := s.links.part("capture", "1.0.0", appFiles(""), on)
	bad["sha256"] = strings.Repeat("0", 64)
	s.relay.setPlan(plan1(1, bad))
	k := s.start()
	waitFor(t, "failed", func() bool { p := partOf(k, "capture"); return p.State == "failed" && strings.Contains(p.Error, "download_failed") })
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.0.0 — download_failed") })
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
	if exists(versionDir(s.home, "capture", "1.3.2")) || !exists(keep) {
		t.Fatal("версия осталась или data/ убрана")
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

// Архив со ссылкой внутри — отказ установки download_failed: в архиве части только файлы и папки.
func TestEtArchiveLinkRefused(t *testing.T) {
	s := newStand(t)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	b, _ := json.Marshal(map[string]any{"run": []string{"x"}})
	tw.WriteHeader(&tar.Header{Name: "app.json", Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg})
	tw.Write(b)
	tw.WriteHeader(&tar.Header{Name: "link", Linkname: "app.json", Typeflag: tar.TypeSymlink})
	tw.Close()
	zw.Close()
	s.relay.setPlan(plan1(1, s.links.partTgz("capture", "1.0.0", buf.Bytes(), on)))
	k := s.start()
	waitFor(t, "download_failed", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.Contains(p.Error, "download_failed") && strings.Contains(p.Error, "только файлы и папки")
	})
}

// Процесс не читает ввод: 256 КБ ввода и «убей» — процесс снят, хозяин получил выход SIGKILL
// (опыт 1 нояб. на 0.5.6: от 8 КБ процесс жив через 8 с).
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
	if d > 2*time.Second {
		t.Fatalf("снят через %v", d)
	}
	waitFor(t, "процесс снят", func() bool { return !alive(f.Pid) })
}

// На старте keeper убирает свои папки версий, кроме той, что работает (машины 1 нояб.: 6 версий, 77 МБ);
// откат keeper — скачивание по ссылке из плана.
func TestEtKeeperVersionsCleanedOnStart(t *testing.T) {
	s := newStand(t)
	for _, v := range []string{"0.5.1", "0.5.6", keeperVersion} {
		os.MkdirAll(versionDir(s.home, "keeper", v), 0o700)
	}
	s.relay.setPlan(plan1(1))
	s.start()
	es, _ := os.ReadDir(partDir(s.home, "keeper"))
	var got []string
	for _, e := range es {
		got = append(got, e.Name())
	}
	if strings.Join(got, " ") != keeperVersion {
		t.Fatalf("версии keeper: %v", got)
	}
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

// Штатная остановка: keeper дописал своё — keeper_exit последняя его строка в журнале, после Stop он не пишет
// (находка пользователя 1 нояб.: CI на ubuntu — «journal: directory not empty» при уборке после Stop).
func TestEtStopLastLine(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("chatty"), on)))
	k := s.start()
	waitFor(t, "вывод идёт", func() bool { return journalHas(s.home, `"line":"tick 20"`) })
	k.Stop()
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
