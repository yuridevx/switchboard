package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestJournalLineFormat(t *testing.T) {
	var echo bytes.Buffer
	dir := t.TempDir()
	j := newJournal(dir, "laptop", &echo)
	j.now = func() time.Time { return time.Date(2026, 10, 30, 10, 40, 5, 123e6, time.UTC) }
	j.stop("host_exit", "Host 1.4.0 вышел с кодом 1: <TypeError>", "code", 1)
	j.refuse("first_line", "bad_key", "ключ не совпал · op spawn")
	want := `{"t":"2026-10-30T10:40:05.123Z","part":"keeper","machine":"laptop","who":"keeper","kind":"stop","ev":"host_exit","why":"Host 1.4.0 вышел с кодом 1: <TypeError>","code":1}` + "\n" +
		`{"t":"2026-10-30T10:40:05.123Z","part":"keeper","machine":"laptop","who":"keeper","kind":"refuse","ev":"first_line","word":"bad_key","why":"ключ не совпал · op spawn"}` + "\n"
	b, err := os.ReadFile(filepath.Join(dir, "keeper-2026-10-30.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != want || echo.String() != want {
		t.Fatalf("журнал:\n%s\nждали:\n%s", b, want)
	}
}

func TestConfKeepsUnknownFields(t *testing.T) {
	home := t.TempDir()
	if m, err := readConf(home); err != nil || len(m) != 0 {
		t.Fatalf("нет файла: %v %v", m, err)
	}
	writeConf(home, map[string]any{"node": "/usr/bin/node", "host": "1.4.0", "extra": 7.0})
	if err := setConf(home, "host", "1.4.1"); err != nil {
		t.Fatal(err)
	}
	m, _ := readConf(home)
	if m["host"] != "1.4.1" || m["node"] != "/usr/bin/node" || m["extra"] != 7.0 {
		t.Fatalf("keeper.json: %v", m)
	}
	if _, err := os.Stat(confPath(home) + ".tmp"); err == nil {
		t.Fatal("остался временный файл")
	}
}

func TestVersionExists(t *testing.T) {
	home := t.TempDir()
	os.MkdirAll(hostDir(home, "1.4.0"), 0o700)
	for v, want := range map[string]bool{"1.4.0": true, "1.4.1": false, "": false, ".": false, "..": false, "../host": false, `1.4.0\..`: false} {
		if got := versionExists(home, v); got != want {
			t.Errorf("versionExists(%q) = %v", v, got)
		}
	}
}

// Ввод Host — одна строка { keeper, key }: адрес порта и 32 случайных байта; ключа нет в журнале.
func TestHostStdinLine(t *testing.T) {
	e := newEnv(t)
	var hand map[string]string
	if err := json.Unmarshal([]byte(e.host.Stdin), &hand); err != nil || len(hand) != 2 {
		t.Fatalf("ввод Host: %q", e.host.Stdin)
	}
	if hand["keeper"] != e.k.Addr() || !regexp.MustCompile(`^127\.0\.0\.1:\d+$`).MatchString(hand["keeper"]) {
		t.Fatalf("адрес: %q", hand["keeper"])
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(hand["key"]) {
		t.Fatalf("ключ: %q", hand["key"])
	}
	e.control(e.host).list()
	for _, f := range mustGlob(t, filepath.Join(e.home, "journal", "*")) {
		b, _ := os.ReadFile(f)
		if bytes.Contains(b, []byte(hand["key"])) {
			t.Fatal("ключ keeper попал в журнал")
		}
	}
	if b, _ := os.ReadFile(confPath(e.home)); bytes.Contains(b, []byte(hand["key"])) {
		t.Fatal("ключ keeper попал в keeper.json")
	}
}

func TestRefusals(t *testing.T) {
	e := newEnv(t)
	// незнакомое действие в первой строке — отказ и закрыто
	cl := e.host.first(t, "dance", nil)
	if r := cl.read(); r["error"] != "unknown_op" {
		t.Fatalf("первая строка: %v", r)
	}
	cl.eof()
	// не JSON — как без ключа
	raw := dialTo(t, e.k.Addr())
	raw.raw("hello")
	if r := raw.read(); r["error"] != "bad_key" {
		t.Fatalf("не JSON: %v", r)
	}
	ctl := e.control(e.host)
	for req, word := range map[string]string{
		`{"op":"dance"}`:                    "unknown_op",
		`{"op":"kill","id":"nobody"}`:       "unknown_id",
		`{"op":"upgrade","version":"../x"}`: "unknown_version",
		`not json`:                          "bad_frame",
	} {
		ctl.raw(req)
		if r := ctl.read(); r["ok"] != false || r["error"] != word {
			t.Fatalf("%s: %v, ждали %s", req, r, word)
		}
	}
	// управление живо после отказов
	if l := ctl.list(); len(l) != 0 {
		t.Fatalf("list: %v", l)
	}
	a := e.host.first(t, "attach", map[string]any{"id": "nobody"})
	if r := a.read(); r["error"] != "unknown_id" {
		t.Fatalf("attach: %v", r)
	}
	a.eof()
}

func TestSpawnFailed(t *testing.T) {
	e := newEnv(t)
	cl := e.host.first(t, "spawn", map[string]any{"id": "site", "command": filepath.Join(e.home, "no-such-claude")})
	if r := cl.read(); r["error"] != "spawn_failed" {
		t.Fatalf("ответ: %v", r)
	}
	cl.eof()
	r := records(e.journal(), map[string]any{"kind": "refuse", "word": "spawn_failed", "id": "site"})
	if len(r) != 1 || !strings.Contains(r[0]["why"].(string), "no-such-claude") {
		t.Fatalf("журнал: %v", r)
	}
	if l := e.control(e.host).list(); len(l) != 0 {
		t.Fatalf("list: %v", l)
	}
}

// env из spawn — всё окружение процесса: keeper ничего не добавляет. cwd — как передан.
func TestSpawnEnvAndCwdExact(t *testing.T) {
	e := newEnv(t)
	os.Setenv("KEEPER_PARENT_ONLY", "x")
	defer os.Unsetenv("KEEPER_PARENT_ONLY")
	env := map[string]string{"KEEPER_TEST_CHILD": "1", "FOO": "bar"}
	for _, k := range []string{"SYSTEMROOT", "PATH"} {
		if v, ok := os.LookupEnv(k); ok {
			env[k] = v
		}
	}
	cl := e.host.first(t, "spawn", map[string]any{"id": "site", "command": e.exe, "args": []string{"claude"}, "env": env, "cwd": e.home})
	if r := cl.read(); r["ok"] != true {
		t.Fatalf("spawn: %v", r)
	}
	cl.raw("env FOO")
	cl.raw("env KEEPER_PARENT_ONLY")
	if a, b := cl.readLine(), cl.readLine(); a != "env FOO=bar" || b != "env KEEPER_PARENT_ONLY=<unset>" {
		t.Fatalf("окружение: %q %q", a, b)
	}
}

// Остановка, пока Host не открыл управление: stop machine приходит сразу после ответа на control.
func TestStopBeforeControl(t *testing.T) {
	e := newEnv(t)
	stopped := make(chan struct{})
	go func() {
		e.k.Stop()
		close(stopped)
	}()
	eventually(t, "keeper_stop в журнале", func() bool {
		return len(records(e.journal(), map[string]any{"ev": "keeper_stop"})) == 1
	})
	ctl := e.control(e.host)
	if s := ctl.read(); s["op"] != "stop" || s["reason"] != "machine" {
		t.Fatalf("ждали stop machine: %v", s)
	}
	// новые процессы не принимаются
	cl := e.host.first(t, "spawn", map[string]any{"id": "x", "command": e.exe, "args": []string{"claude"}})
	if r := cl.read(); r["error"] != "shutting_down" {
		t.Fatalf("spawn при остановке: %v", r)
	}
	e.host.exit(0, "")
	select {
	case <-stopped:
	case <-time.After(15 * time.Second):
		t.Fatal("keeper не вышел")
	}
	// после остановки Host не перезапускается
	e.h.none(t, 300*time.Millisecond)
}

// Нет версии Host в keeper.json — Host не запускается, причина в журнале; keeper работает.
func TestNoHostVersion(t *testing.T) {
	e := prepare(t)
	writeConf(e.home, map[string]any{"node": e.exe})
	e.start()
	e.h.none(t, 500*time.Millisecond)
	f := records(e.journal(), map[string]any{"ev": "host_failed", "kind": "stop"})
	if len(f) != 1 || f[0]["why"] != "в keeper.json нет версии Host — не запускаю" {
		t.Fatalf("журнал: %v", f)
	}
}

// Порядок на управлении: ответ на каждый запрос — по порядку запросов.
func TestControlRepliesInOrder(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	e.spawn(e.host, "site")
	ctl.raw(`{"op":"list"}` + "\n" + `{"op":"kill","id":"nobody"}` + "\n" + `{"op":"list"}`)
	a, b, c := ctl.read(), ctl.read(), ctl.read()
	if a["ok"] != true || b["error"] != "unknown_id" || c["ok"] != true {
		t.Fatalf("ответы: %v %v %v", a, b, c)
	}
}

func mustGlob(t *testing.T, p string) []string {
	m, err := filepath.Glob(p)
	if err != nil || len(m) == 0 {
		t.Fatalf("нет файлов %s", p)
	}
	return m
}
