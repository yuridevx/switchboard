//go:build linux

package main

import (
	"encoding/json"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Сигнал остановки от ОС держателю: ввод процесса закрыт, процесс вышел штатно, выход отдан хозяину.
func TestEtHolderSignalClosesInput(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf holdFile
	b, _ := os.ReadFile(holdPath(home, "s"))
	json.Unmarshal(b, &hf)
	// подключение принято — держатель уже слушает сигналы
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	syscall.Kill(hf.Holder, syscall.SIGTERM)
	var out strings.Builder
	x, err := c.read(func(b []byte) { out.Write(b) })
	if err != nil || x == nil || x.Code == nil || *x.Code != 0 || !x.OSStop || !strings.Contains(out.String(), "bye") {
		t.Fatalf("выход %+v %v, вывод %q", x, err, out.String())
	}
	if !journalHas(home, `"ev":"hold_signal"`) {
		t.Fatal("нет строки hold_signal")
	}
}

// 5508 · Вышедший держатель не остаётся зомби у того, кто его запустил (wsl 3 нояб.: 23 зомби [keeper] под keeper run
// за 11 ч — spawnHolder отпускал держателя без Wait).
func TestEtHolderReaped(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf holdFile
	b, _ := os.ReadFile(holdPath(home, "s"))
	json.Unmarshal(b, &hf)
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	c.closeInput()
	if x, err := c.read(func([]byte) {}); err != nil || x == nil {
		t.Fatalf("выход %+v %v", x, err)
	}
	c.Close()
	// забранный процесс исчезает из таблицы целиком; зомби отвечает на сигнал 0
	waitFor(t, "держатель забран", func() bool { return syscall.Kill(hf.Holder, 0) != nil })
}

// Остановка ОС: держатель закрыл ввод части по сигналу — keeper считает выход остановкой, а не падением: без
// перезапуска и без part.failed (ВМ win11-2 1 нояб.: на перезагрузке держатель узнал об остановке на 5 с раньше службы,
// keeper перезапустил часть посреди выключения и поставил failed).
func TestEtOSStopIsNotCrash(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	var hf holdFile
	b, _ := os.ReadFile(holdPath(s.home, "capture"))
	json.Unmarshal(b, &hf)
	syscall.Kill(hf.Holder, syscall.SIGTERM)
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	time.Sleep(time.Second)
	starts := strings.Count(readJournal(s.home), `"ev":"part_start"`)
	if p := partOf(k, "capture"); p.State != "stopped" || p.Restarts != 0 || starts != 1 || s.relay.ledgerHas("part.failed") {
		t.Fatalf("выход по остановке ОС принят за падение: %+v, стартов %d", p, starts)
	}
}
