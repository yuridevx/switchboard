//go:build linux

package main

import (
	"encoding/json"
	"os"
	"strings"
	"syscall"
	"testing"
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
	if err != nil || x == nil || x.Code == nil || *x.Code != 0 || !strings.Contains(out.String(), "bye") {
		t.Fatalf("выход %+v %v, вывод %q", x, err, out.String())
	}
	if !journalHas(home, `"ev":"hold_signal"`) {
		t.Fatal("нет строки hold_signal")
	}
}
