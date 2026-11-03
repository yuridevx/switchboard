package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// nameStand — домашняя папка пользователя в temp и прежние правила имени после эталона.
func nameStand(t *testing.T) string {
	t.Helper()
	u := t.TempDir()
	t.Setenv("HOME", u)
	t.Setenv("USERPROFILE", u)
	t.Setenv("SWITCHBOARD_HOME", "")
	s, f := serviceName, fleetName
	t.Cleanup(func() { serviceName, fleetName = s, f })
	return u
}

// 5521 · install --name prod: служба switchboard-keeper-prod, папка ~/.switchboard-prod, команда службы run --name prod;
// пропуск и keeper.json — в своей папке, флаги установки — как без имени (дизайн «Любой агент», этап 0).
func TestEtNameInstallOwnFolder(t *testing.T) {
	u := nameStand(t)
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"type": "reply", "id": "install", "ok": true, "result": map[string]string{"key": "host.pc.ab12.sig"}})
	}))
	defer gate.Close()
	rest, err := useName([]string{"--name", "prod", "--worker", "gate=" + gate.URL})
	if err != nil {
		t.Fatal(err)
	}
	if serviceName != "switchboard-keeper-prod" || !reflect.DeepEqual(runArgs(), []string{"run", "--name", "prod"}) {
		t.Fatalf("служба %q, команда %v", serviceName, runArgs())
	}
	home, _ := homeDir()
	if want := filepath.Join(u, ".switchboard-prod"); home != want {
		t.Fatalf("папка %q, а надо %q", home, want)
	}
	f, err := parseInstall(rest)
	if err != nil {
		t.Fatal(err)
	}
	if err := prepareConf(f, bufio.NewReader(strings.NewReader("invite\n"))); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "machine.key")); strings.TrimSpace(string(b)) != "host.pc.ab12.sig" {
		t.Fatalf("machine.key %q", b)
	}
	if _, err := os.Stat(filepath.Join(u, ".switchboard")); !os.IsNotExist(err) {
		t.Fatalf("чужая папка тронута: %v", err)
	}
}

// 5522 · Без имени — служба и папка прежние, команда run; имя с путём — отказ словом (дизайн этапа 0).
func TestEtNameAbsentSameAsBefore(t *testing.T) {
	u := nameStand(t)
	rest, err := useName([]string{"--hide"})
	if err != nil || !reflect.DeepEqual(rest, []string{"--hide"}) {
		t.Fatalf("%v %v", rest, err)
	}
	home, _ := homeDir()
	if serviceName != "switchboard-keeper" || home != filepath.Join(u, ".switchboard") || !reflect.DeepEqual(runArgs(), []string{"run"}) {
		t.Fatalf("служба %q, папка %q, команда %v", serviceName, home, runArgs())
	}
	for _, bad := range [][]string{{"--name"}, {"--name", "../x"}, {"--name", ""}} {
		if _, err := useName(bad); err == nil {
			t.Fatalf("%v без отказа", bad)
		}
	}
}

// 5523 · keeper run --name prod работает в своей папке (дизайн этапа 0); что часть получает её в SWITCHBOARD_HOME — TestEtPartEnv.
func TestEtNameRunOwnFolder(t *testing.T) {
	u := nameStand(t)
	own := filepath.Join(u, ".switchboard-prod")
	os.MkdirAll(own, 0o700)
	os.WriteFile(filepath.Join(own, "machine.key"), []byte("host.pc.ab12.sig\n"), 0o600)
	os.WriteFile(filepath.Join(own, "keeper.json"), []byte("{}\n"), 0o600)
	self, _ := os.Executable()
	cmd := exec.Command(self, "keeper", "run", "--name", "prod")
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	waitFor(t, "журнал в своей папке", func() bool {
		ms, _ := filepath.Glob(filepath.Join(own, "journal", "keeper-*.jsonl"))
		return len(ms) == 1
	})
	if _, err := os.Stat(filepath.Join(u, ".switchboard")); !os.IsNotExist(err) {
		t.Fatalf("прежняя папка появилась: %v", err)
	}
}
