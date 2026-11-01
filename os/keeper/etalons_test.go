package main

// Эталоны keeper — исполнителя плана, и держателя. Источники свойств — дизайн «Выпуски флота» (слово пользователя
// 1 нояб.: состояние машины спускается сверху, keeper исполняет и отвечает состояние, держатели) и замеры 1 нояб.
import (
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
	s.relay.push(map[string]any{"type": "releases.plan", "from": ".releases", "rev": 2, "parts": []any{bad}})
	waitFor(t, "download_failed", func() bool { return strings.Contains(partOf(k, "capture").Error, "download_failed") })
	p := partOf(k, "capture")
	if p.State != "running" || p.Pid != pid || p.Version != "1.3.2" {
		t.Fatalf("прежняя версия тронута: %+v", p)
	}
	if exists(versionDir(s.home, "capture", "1.4.0")) {
		t.Fatal("папка битой версии осталась")
	}
}

// Смена версии без наложения: новая стартует после выхода старой; part.updated; предыдущая папка остаётся.
func TestEtVersionSwitchNoOverlap(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	s.relay.push(map[string]any{"type": "releases.plan", "from": ".releases", "rev": 2, "parts": []any{s.links.part("capture", "1.4.0", appFiles(""), on)}})
	waitFor(t, "1.4.0 running", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.4.0" })
	waitFor(t, "part.updated", func() bool {
		for _, e := range s.relay.ledgerEvs() {
			if strings.HasPrefix(e, "part.updated win: capture 1.3.2 → 1.4.0") {
				return true
			}
		}
		return false
	})
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
	s.relay.push(map[string]any{"type": "releases.plan", "from": ".releases", "rev": 2, "parts": []any{off}})
	waitFor(t, "stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	time.Sleep(time.Second)
	if partOf(k, "capture").State != "stopping" {
		t.Fatal("stopping держится без таймера")
	}
	off["force"] = true
	s.relay.push(map[string]any{"type": "releases.plan", "from": ".releases", "rev": 3, "parts": []any{off}})
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
	waitFor(t, "part.failed", func() bool {
		for _, e := range s.relay.ledgerEvs() {
			if strings.HasPrefix(e, "part.failed win: capture 1.3.2") {
				return true
			}
		}
		return false
	})
	// та же запись части с новой rev — keeper failed не трогает: решает тот, кто правит план
	same := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.relay.push(map[string]any{"type": "releases.plan", "from": ".releases", "rev": 2, "parts": []any{same}})
	time.Sleep(700 * time.Millisecond)
	if partOf(k, "capture").State != "failed" {
		t.Fatal("failed поднят без правки плана")
	}
	// on: false, затем on: true — чистый перезапуск
	off := s.links.part("capture", "1.3.2", appFiles(""), map[string]any{"on": false})
	s.relay.push(map[string]any{"type": "releases.plan", "from": ".releases", "rev": 3, "parts": []any{off}})
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	s.relay.push(map[string]any{"type": "releases.plan", "from": ".releases", "rev": 4, "parts": []any{same}})
	waitFor(t, "running снова", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 0 })
}

// Перезагрузка без связи: keeper исполняет сохранённый план.
func TestEtSavedPlanWithoutRelay(t *testing.T) {
	s := newStand(t)
	pl := plan1(7, s.links.part("capture", "1.3.2", appFiles(""), on))
	b, _ := json.Marshal(pl)
	os.WriteFile(planPath(s.home), b, 0o600)
	writeConf(s.home, map[string]any{"machine": "win"}) // relay нет
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
	k, err := Start(s.home, nil)
	if err != nil {
		t.Fatal(err)
	}
	exited := make(chan int, 1)
	k.self = func() (string, error) { return target, nil }
	k.exit = func(code int) { exited <- code }
	select {
	case code := <-exited:
		if code != 3 {
			t.Fatalf("код выхода %d", code)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	b, _ := os.ReadFile(target)
	if len(b) != len(bin) {
		t.Fatal("файл keeper не подменён")
	}
	if !exists(target + "." + keeperVersion + ".old") {
		t.Fatal("старый файл не переименован")
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
	exited := false
	k.exit = func(int) { exited = true }
	waitFor(t, "check_failed", func() bool { return strings.Contains(partOf(k, "keeper").Error, "check_failed") })
	if exited {
		t.Fatal("keeper вышел после check_failed")
	}
}

/* ===== держатель ===== */

// Держатель копит вывод без хозяина и отдаёт его хозяину; второй хозяин вытесняет первого; чужой ключ — bad_key.
func TestEtHolderBufferAndOwner(t *testing.T) {
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
