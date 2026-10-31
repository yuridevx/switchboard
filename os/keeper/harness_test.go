package main

// Стенд keeper: настоящий сервер на 127.0.0.1, вместо Host — подставной процесс,
// вместо claude — процесс-заглушка. Оба — этот же тестовый бинарь в другой роли.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("KEEPER_TEST_CHILD") == "1" && len(os.Args) > 1 {
		switch os.Args[1] {
		case "claude":
			fakeClaude()
			return
		case "sleeper":
			time.Sleep(10 * time.Minute)
			return
		case "keeper-proc":
			os.Exit(runConsole())
		}
		if filepath.Base(os.Args[1]) == "host" {
			fakeHost(os.Args[1])
			return
		}
	}
	os.Setenv("KEEPER_TEST_CHILD", "1")
	os.Exit(m.Run())
}

/* ===== роли дочерних процессов ===== */

// fakeClaude — заглушка claude: команды строками в stdin, конец ввода — «bye» и выход 0.
func fakeClaude() {
	fmt.Fprintln(os.Stderr, "claude: start")
	var wmu sync.Mutex
	out := func(s string) {
		wmu.Lock()
		os.Stdout.WriteString(s + "\n")
		wmu.Unlock()
	}
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "echo":
			out(strings.Join(f[1:], " "))
		case "sleep": // команда Bash посреди хода
			d, _ := time.ParseDuration(f[1])
			time.Sleep(d)
			out("slept " + f[1])
		case "ticks": // долгий поток вывода
			n, _ := strconv.Atoi(f[1])
			d, _ := time.ParseDuration(f[2])
			go func() {
				for i := 1; i <= n; i++ {
					out(fmt.Sprintf("tick %d", i))
					time.Sleep(d)
				}
				out("ticks done")
			}()
		case "child": // потомок, как процесс Bash
			c := exec.Command(os.Args[0], "sleeper")
			c.Start()
			out(fmt.Sprintf("child %d", c.Process.Pid))
		case "env":
			v, ok := os.LookupEnv(f[1])
			if !ok {
				v = "<unset>"
			}
			out("env " + f[1] + "=" + v)
		case "stderr":
			fmt.Fprintln(os.Stderr, strings.Join(f[1:], " "))
		case "exit":
			fmt.Fprintln(os.Stderr, "fatal: exit "+f[1])
			code, _ := strconv.Atoi(f[1])
			os.Exit(code)
		}
	}
	out("bye")
	fmt.Fprintln(os.Stderr, "claude: stdin closed")
}

// fakeHost — подставной Host: строку из stdin отдаёт стенду, держит соединения с keeper
// туннелем (умер Host — умерли его соединения) и выходит по команде стенда.
func fakeHost(entry string) {
	dir := filepath.Dir(entry)
	in, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	var hand struct{ Keeper, Key string }
	json.Unmarshal([]byte(in), &hand)
	addr, err := os.ReadFile(filepath.Join(dir, "harness"))
	if err != nil {
		os.Exit(3)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Exit(3)
	}
	hc, err := net.Dial("tcp", strings.TrimSpace(string(addr)))
	if err != nil {
		os.Exit(3)
	}
	hc.Write(line(map[string]any{"version": filepath.Base(dir), "stdin": strings.TrimSpace(in), "tunnel": ln.Addr().String(), "pid": os.Getpid()}))
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go tunnel(c, hand.Keeper)
		}
	}()
	dec := json.NewDecoder(hc)
	var cmd struct {
		Exit   int
		Stderr string
	}
	if dec.Decode(&cmd) != nil {
		os.Exit(0)
	}
	if cmd.Stderr != "" {
		fmt.Fprintln(os.Stderr, cmd.Stderr)
	}
	os.Exit(cmd.Exit)
}

func tunnel(c net.Conn, addr string) {
	k, err := net.Dial("tcp", addr)
	if err != nil {
		c.Close()
		return
	}
	go func() {
		io.Copy(k, c)
		k.(*net.TCPConn).CloseWrite()
	}()
	io.Copy(c, k)
	c.(*net.TCPConn).CloseWrite()
}

/* ===== стенд ===== */

type harness struct {
	ln    net.Listener
	hosts chan *fakeHostH
	mu    sync.Mutex
	all   []*fakeHostH
}

type fakeHostH struct {
	Version string
	Stdin   string
	Tunnel  string
	Pid     int
	c       net.Conn
	key     string
	addr    string
}

func newHarness(t *testing.T) *harness {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{ln: ln, hosts: make(chan *fakeHostH, 16)}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			b, err := bufio.NewReader(c).ReadBytes('\n')
			if err != nil {
				c.Close()
				continue
			}
			f := &fakeHostH{c: c}
			json.Unmarshal(b, f)
			var hand struct{ Keeper, Key string }
			json.Unmarshal([]byte(f.Stdin), &hand)
			f.key, f.addr = hand.Key, hand.Keeper
			h.mu.Lock()
			h.all = append(h.all, f)
			h.mu.Unlock()
			h.hosts <- f
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return h
}

// next — следующий запущенный keeper Host.
func (h *harness) next(t *testing.T) *fakeHostH {
	t.Helper()
	select {
	case f := <-h.hosts:
		return f
	case <-time.After(15 * time.Second):
		t.Fatal("keeper не запустил Host")
		return nil
	}
}

// none — новый Host не запущен за d.
func (h *harness) none(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case f := <-h.hosts:
		t.Fatalf("лишний запуск Host %s pid %d", f.Version, f.Pid)
	case <-time.After(d):
	}
}

func (h *harness) exitAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, f := range h.all {
		f.c.Write([]byte(`{"exit":0}` + "\n"))
	}
}

// exit — Host выходит с кодом, перед этим строка в stderr.
func (f *fakeHostH) exit(code int, stderr string) {
	f.c.Write(line(map[string]any{"exit": code, "stderr": stderr}))
}

type env struct {
	t    *testing.T
	home string
	exe  string
	h    *harness
	k    *Keeper
	host *fakeHostH
}

// newEnv — ~/.switchboard во временной папке: keeper.json с Host 1.4.0, папки версий, keeper запущен.
func newEnv(t *testing.T, extra ...string) *env {
	e := prepare(t, extra...)
	e.start()
	e.host = e.h.next(t)
	return e
}

func prepare(t *testing.T, extra ...string) *env {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, home: t.TempDir(), exe: exe, h: newHarness(t)}
	for _, v := range append([]string{"1.4.0"}, extra...) {
		d := hostDir(e.home, v)
		os.MkdirAll(d, 0o700)
		os.WriteFile(filepath.Join(d, "harness"), []byte(e.h.ln.Addr().String()), 0o600)
	}
	if err := writeConf(e.home, map[string]any{"node": exe, "host": "1.4.0", "machine": "laptop"}); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *env) start() {
	k, err := Start(e.home, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	e.k = k
	e.t.Cleanup(func() { e.close(k) })
}

// close — штатная остановка; Host-заглушки выходят по команде стенда.
func (e *env) close(k *Keeper) {
	done := make(chan struct{})
	go func() {
		k.Stop()
		close(done)
	}()
	deadline := time.After(20 * time.Second)
	for {
		select {
		case <-done:
			return
		case <-deadline:
			e.t.Error("keeper не остановился за 20 с")
			return
		case <-time.After(200 * time.Millisecond):
			e.h.exitAll()
		}
	}
}

/* ===== клиент протокола ===== */

type client struct {
	t  *testing.T
	c  net.Conn
	br *bufio.Reader
}

func dialTo(t *testing.T, addr string) *client {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return &client{t: t, c: c, br: bufio.NewReader(c)}
}

func (cl *client) send(v any) { cl.c.Write(line(v)) }
func (cl *client) raw(s string) {
	cl.c.Write([]byte(s + "\n"))
}

// readLine — строка вывода или JSON; ждёт до 10 с.
func (cl *client) readLine() string {
	cl.t.Helper()
	cl.c.SetReadDeadline(time.Now().Add(10 * time.Second))
	s, err := cl.br.ReadString('\n')
	if err != nil {
		cl.t.Fatalf("чтение: %v (прочитано %q)", err, s)
	}
	return strings.TrimRight(s, "\r\n")
}

func (cl *client) read() map[string]any {
	cl.t.Helper()
	s := cl.readLine()
	m := map[string]any{}
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		cl.t.Fatalf("не JSON: %q", s)
	}
	return m
}

// until — читать строки, пока не придёт want; вернуть прочитанные до неё.
func (cl *client) until(want string) []string {
	cl.t.Helper()
	var got []string
	for {
		s := cl.readLine()
		if s == want {
			return got
		}
		got = append(got, s)
	}
}

// eof — дочитать до конца соединения; вернуть остаток.
func (cl *client) eof() string {
	cl.t.Helper()
	cl.c.SetReadDeadline(time.Now().Add(10 * time.Second))
	b, err := io.ReadAll(cl.br)
	if err != nil {
		cl.t.Fatalf("ждали конец соединения: %v (прочитано %q)", err, b)
	}
	return string(b)
}

func (f *fakeHostH) dial(t *testing.T) *client { return dialTo(t, f.Tunnel) }

// first — первая строка с ключом этого Host.
func (f *fakeHostH) first(t *testing.T, op string, kv map[string]any) *client {
	cl := f.dial(t)
	m := map[string]any{"key": f.key, "proto": 1, "op": op}
	for k, v := range kv {
		m[k] = v
	}
	cl.send(m)
	return cl
}

func (e *env) control(f *fakeHostH) *client {
	e.t.Helper()
	cl := f.first(e.t, "control", nil)
	r := cl.read()
	if r["ok"] != true {
		e.t.Fatalf("control: %v", r)
	}
	return cl
}

func (e *env) spawn(f *fakeHostH, id string) (*client, int) {
	e.t.Helper()
	cl := f.first(e.t, "spawn", map[string]any{"id": id, "command": e.exe, "args": []string{"claude"}})
	r := cl.read()
	if r["ok"] != true {
		e.t.Fatalf("spawn %s: %v", id, r)
	}
	return cl, num(r["result"], "pid")
}

func (e *env) attach(f *fakeHostH, id string) (*client, map[string]any) {
	e.t.Helper()
	cl := f.first(e.t, "attach", map[string]any{"id": id})
	r := cl.read()
	if r["ok"] != true {
		e.t.Fatalf("attach %s: %v", id, r)
	}
	return cl, r["result"].(map[string]any)
}

// call — запрос по управлению; пропускает exited до ответа.
func (cl *client) call(v any) map[string]any {
	cl.t.Helper()
	cl.send(v)
	for {
		r := cl.read()
		if r["op"] == "reply" {
			return r
		}
	}
}

func (cl *client) list() []map[string]any {
	cl.t.Helper()
	r := cl.call(map[string]any{"op": "list"})
	out := []map[string]any{}
	for _, p := range r["result"].(map[string]any)["processes"].([]any) {
		out = append(out, p.(map[string]any))
	}
	return out
}

// event — следующее событие op (exited, stop), ответы пропускаются.
func (cl *client) event(op string) map[string]any {
	cl.t.Helper()
	for {
		r := cl.read()
		if r["op"] == op {
			return r
		}
	}
}

func num(v any, k string) int {
	m, _ := v.(map[string]any)
	f, _ := m[k].(float64)
	return int(f)
}

/* ===== журнал и ожидания ===== */

func (e *env) journal() []map[string]any {
	return readJournal(e.t, e.home)
}

func readJournal(t *testing.T, home string) []map[string]any {
	var out []map[string]any
	files, _ := filepath.Glob(filepath.Join(home, "journal", "keeper-*.jsonl"))
	for _, f := range files {
		b, _ := os.ReadFile(f)
		for _, s := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			if s == "" {
				continue
			}
			m := map[string]any{}
			if err := json.Unmarshal([]byte(s), &m); err != nil {
				t.Fatalf("строка журнала не JSON: %q", s)
			}
			out = append(out, m)
		}
	}
	return out
}

// records — записи журнала с этими полями.
func records(js []map[string]any, match map[string]any) []map[string]any {
	var out []map[string]any
next:
	for _, r := range js {
		for k, v := range match {
			if fmt.Sprint(r[k]) != fmt.Sprint(v) {
				continue next
			}
		}
		out = append(out, r)
	}
	return out
}

func eventually(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatalf("не дождались: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func killPid(t *testing.T, pid int) {
	t.Helper()
	p, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
}

func childPid(t *testing.T, s string) int {
	t.Helper()
	var pid int
	if _, err := fmt.Sscanf(s, "child %d", &pid); err != nil {
		t.Fatalf("ждали «child <pid>», пришло %q", s)
	}
	return pid
}
