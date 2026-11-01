package main

// Стенд keeper: настоящие keeper и держатели на временной папке, поддельный relay (вебсокет), поддельные ссылки
// на архивы. Приложение, держатель и новый файл keeper — этот же тестовый бинарь в другой роли.
import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

func TestMain(m *testing.M) {
	if os.Getenv("KEEPER_TEST_CHILD") == "1" && len(os.Args) > 1 {
		switch os.Args[1] {
		case "hold":
			os.Exit(runHold(os.Args[2:]))
		case "app":
			fakeApp(os.Args[2:])
			return
		case "version":
			fmt.Println(os.Getenv("KEEPER_TEST_VERSION"))
			return
		}
	}
	os.Setenv("KEEPER_TEST_CHILD", "1")
	os.Exit(m.Run())
}

// fakeApp — приложение: строка о старте, ввод закрыт — «bye» и выход 0; stubborn — конец ввода не слушает.
func fakeApp(args []string) {
	mode := ""
	if len(args) > 0 {
		mode = args[0]
	}
	fmt.Printf("app %s start pid %d\n", os.Getenv("SWITCHBOARD_VERSION"), os.Getpid())
	fmt.Fprintln(os.Stderr, "app: stderr line")
	br := bufio.NewReader(os.Stdin)
	for {
		if _, err := br.ReadString('\n'); err != nil {
			break
		}
	}
	if mode == "stubborn" {
		time.Sleep(10 * time.Minute)
	}
	fmt.Println("bye")
}

/* ===== поддельный relay ===== */

type fakeRelay struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	plan   map[string]any
	ws     *websocket.Conn
	ledger []map[string]any
	reply  map[string]chan map[string]any
	opened chan struct{}
}

func newFakeRelay(t *testing.T) *fakeRelay {
	r := &fakeRelay{t: t, reply: map[string]chan map[string]any{}, opened: make(chan struct{}, 10)}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		ws, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		ctx := context.Background()
		_, b, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var hello map[string]any
		json.Unmarshal(b, &hello)
		if hello["type"] != "hello" || !strings.HasPrefix(fmt.Sprint(hello["key"]), "host.") || hello["part"] != "keeper" {
			ws.Close(1008, "bad_key")
			return
		}
		r.mu.Lock()
		r.ws = ws
		r.mu.Unlock()
		ws.Write(ctx, websocket.MessageText, []byte(`{"type":"roster","machines":[],"sessions":[],"clients":[],"workers":[]}`))
		r.opened <- struct{}{}
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if string(b) == "ping" {
				ws.Write(ctx, websocket.MessageText, []byte("pong"))
				continue
			}
			var f map[string]any
			json.Unmarshal(b, &f)
			switch f["type"] {
			case "releases.plan":
				r.mu.Lock()
				p := r.plan
				r.mu.Unlock()
				out, _ := json.Marshal(map[string]any{"type": "reply", "id": f["id"], "ok": true, "result": p})
				ws.Write(ctx, websocket.MessageText, out)
			case "ledger.add":
				r.mu.Lock()
				r.ledger = append(r.ledger, f)
				r.mu.Unlock()
			case "reply":
				r.mu.Lock()
				c := r.reply[fmt.Sprint(f["id"])]
				r.mu.Unlock()
				if c != nil {
					c <- f
				}
			}
		}
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *fakeRelay) url() string { return "ws" + strings.TrimPrefix(r.srv.URL, "http") }

func (r *fakeRelay) setPlan(p map[string]any) {
	r.mu.Lock()
	r.plan = p
	r.mu.Unlock()
}

// push — кадр keeper от имени from.
func (r *fakeRelay) push(f map[string]any) {
	r.mu.Lock()
	ws := r.ws
	r.mu.Unlock()
	b, _ := json.Marshal(f)
	ws.Write(context.Background(), websocket.MessageText, b)
}

// ask — запрос keeper и его ответ.
func (r *fakeRelay) ask(f map[string]any) map[string]any {
	id := newID()
	c := make(chan map[string]any, 1)
	r.mu.Lock()
	r.reply[id] = c
	r.mu.Unlock()
	f["id"] = id
	f["from"] = "~test"
	r.push(f)
	select {
	case x := <-c:
		return x
	case <-time.After(10 * time.Second):
		r.t.Fatalf("keeper не ответил на %v", f["type"])
		return nil
	}
}

func (r *fakeRelay) ledgerEvs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, f := range r.ledger {
		out = append(out, fmt.Sprint(f["ev"], " ", f["text"]))
	}
	return out
}

/* ===== архивы и ссылки ===== */

type files map[string]string

func tgz(fs files) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for name, body := range fs {
		mode := int64(0o644)
		if strings.HasSuffix(name, ".exe") || strings.Contains(name, "/keeper") {
			mode = 0o755
		}
		tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(body)), Typeflag: tar.TypeReg})
		tw.Write([]byte(body))
	}
	tw.Close()
	zw.Close()
	return buf.Bytes()
}

type links struct {
	srv *httptest.Server
	mu  sync.Mutex
	m   map[string][]byte
}

func newLinks(t *testing.T) *links {
	l := &links{m: map[string][]byte{}}
	l.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		l.mu.Lock()
		b, ok := l.m[r.URL.Path]
		l.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(l.srv.Close)
	return l
}

// part — архив части в ссылках и запись плана для неё.
func (l *links) part(name, version string, fs files, extra map[string]any) map[string]any {
	b := tgz(fs)
	path := "/" + name + "/" + version + ".tgz"
	l.mu.Lock()
	l.m[path] = b
	l.mu.Unlock()
	sum := sha256.Sum256(b)
	p := map[string]any{"part": name, "version": version, "sha256": hex.EncodeToString(sum[:]), "url": l.srv.URL + path}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

// appFiles — app.json приложения: этот тестовый бинарь в роли app.
func appFiles(mode string) files {
	self, _ := os.Executable()
	run := []string{self, "app"}
	if mode != "" {
		run = append(run, mode)
	}
	b, _ := json.Marshal(map[string]any{"run": run})
	return files{"app.json": string(b)}
}

/* ===== keeper на стенде ===== */

type stand struct {
	t     *testing.T
	home  string
	relay *fakeRelay
	links *links
}

func newStand(t *testing.T) *stand {
	home := t.TempDir()
	s := &stand{t: t, home: home, relay: newFakeRelay(t), links: newLinks(t)}
	os.WriteFile(filepath.Join(home, "machine.key"), []byte("host.win.ab12.sig\n"), 0o600)
	writeConf(home, map[string]any{"machine": "win", "relay": s.relay.url()})
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	return s
}

// start — keeper; подмена себя не выходит из процесса теста.
func (s *stand) start() *Keeper {
	k, err := Start(s.home, nil)
	if err != nil {
		s.t.Fatal(err)
	}
	k.exit = func(code int) { k.exitCode = code }
	s.t.Cleanup(k.Stop)
	return k
}

func killHolders(home string) {
	var pids []int
	for _, f := range readHoldFiles(home) {
		if c, _, err := dialHolder(f); err == nil {
			c.kill()
			c.read(func([]byte) {})
			c.Close()
		}
		pids = append(pids, f.Holder)
	}
	// держатель дописывает журнал перед выходом: ждать, пока уйдёт, иначе папку не удалить
	end := time.Now().Add(10 * time.Second)
	for _, p := range pids {
		for alive(p) && time.Now().Before(end) {
			time.Sleep(50 * time.Millisecond)
		}
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	end := time.Now().Add(20 * time.Second)
	for time.Now().Before(end) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("не дождался: %s", what)
}

func partOf(k *Keeper, name string) partState {
	for _, p := range k.state().Parts {
		if p.Part == name {
			return p
		}
	}
	return partState{}
}

func journalHas(home, s string) bool {
	ms, _ := filepath.Glob(filepath.Join(home, "journal", "*.jsonl"))
	for _, m := range ms {
		b, _ := os.ReadFile(m)
		if strings.Contains(string(b), s) {
			return true
		}
	}
	return false
}

func plan1(rev int, parts ...map[string]any) map[string]any {
	ps := []any{}
	for _, p := range parts {
		ps = append(ps, p)
	}
	return map[string]any{"rev": rev, "parts": ps}
}
