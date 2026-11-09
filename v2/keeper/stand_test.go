package main

// Стенд Keeper: настоящие keeper и держатели на временной папке, поддельный флот (POST /call, вебсокет /m/<флот>/<машина>, ссылки на файлы
// сборки). Host, держатель, npm и новый файл keeper — этот же тестовый файл в другой роли. Протокол держателя здесь записан заново, по
// договору: стенд с кодом его не делит.
import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testKey = "home:k8f3a2:0123456789abcdef0123"

func TestMain(m *testing.M) {
	if os.Getenv("KEEPER_TEST_CHILD") == "1" && len(os.Args) > 1 {
		switch a := os.Args[1]; {
		case a == "hold":
			if d, err := time.ParseDuration(os.Getenv("KEEPER_TEST_OWNER_WAIT")); err == nil {
				setOwnerWait(d)
			}
			main()
			return
		case a == "version":
			fmt.Println(os.Getenv("KEEPER_TEST_VERSION"))
			return
		case a == "app":
			fakeApp()
			return
		case strings.HasSuffix(a, "main.ts"):
			fakeHost(a)
			return
		case strings.HasSuffix(a, "npm-cli.js"):
			// под именем npm: свои аргументы — в файл рабочей папки
			os.WriteFile("npm-ran", []byte(strings.Join(os.Args[2:], " ")), 0o644)
			return
		}
	}
	os.Setenv("KEEPER_TEST_CHILD", "1")
	os.Unsetenv("SB_HOME")
	os.Exit(m.Run())
}

// fakeApp — процесс под держателем: строка о старте, эхо каждой строки ввода, ввод закрыт — «bye» и выход 0.
func fakeApp() {
	fmt.Printf("app start pid %d\n", os.Getpid())
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		fmt.Println("echo " + in.Text())
	}
	fmt.Println("bye")
}

// fakeHost — Host сборки: поведение — в тексте его main.ts. ok — живёт до закрытия ввода; crash — падает сразу; crashonce — падает один раз;
// session — как Host, запускает держателя сессии и живёт; deaf — конец ввода не слушает.
func fakeHost(mainTs string) {
	b, _ := os.ReadFile(mainTs)
	mode := strings.TrimSpace(string(b))
	data := os.Getenv("SB_DATA")
	env := map[string]string{}
	for _, n := range []string{"SB_HOME", "SB_FLEET", "SB_MACHINE", "SB_BASE", "SB_BUILD", "SB_DATA", "SB_HOLDER"} {
		env[n] = os.Getenv(n)
	}
	wd, _ := os.Getwd()
	env["cwd"], env["main"] = wd, mainTs
	eb, _ := json.Marshal(env)
	os.WriteFile(filepath.Join(data, "env.json"), eb, 0o644)
	fmt.Printf("host %s start pid %d\n", os.Getenv("SB_BUILD"), os.Getpid())
	switch mode {
	case "crash":
		fmt.Fprintln(os.Stderr, "упал нарочно")
		os.Exit(1)
	case "crashonce":
		mark := filepath.Join(data, "crashed")
		if !fileExists(mark) {
			os.WriteFile(mark, nil, 0o644)
			os.Exit(1)
		}
	case "session":
		if !fileExists(filepath.Join(os.Getenv("SB_HOME"), "procs", "site@win.json")) {
			me, _ := os.Executable()
			if _, err := spawnHolder([]string{"--id", "site@win", "--owner", "host", "--", me, "app"}, os.Environ(), 20*time.Second); err != nil {
				fmt.Fprintln(os.Stderr, "держатель сессии: "+err.Error())
				os.Exit(1)
			}
		}
	case "deaf":
		time.Sleep(2 * time.Minute)
		return
	}
	io.Copy(io.Discard, os.Stdin)
}

/* ===== Поддельный флот ===== */

type fleet struct {
	t     *testing.T
	srv   *httptest.Server
	mu    sync.Mutex
	plan  any // ответ builds.plan; nil — null
	files map[string][]byte
	// что видел флот
	asks    []map[string]any
	auth    []string
	ledger  []map[string]any
	hellos  []map[string]any
	conn    *websocket.Conn
	replies chan map[string]any
	// как отвечает
	closeWith  string // закрыть новое соединение этим словом
	planRefuse string
	redeem     func(f map[string]any) map[string]any
}

func newFleet(t *testing.T) *fleet {
	f := &fleet{t: t, files: map[string][]byte{}, replies: make(chan map[string]any, 16)}
	mux := http.NewServeMux()
	mux.HandleFunc("/call", f.call)
	mux.HandleFunc("/m/", f.socket)
	mux.HandleFunc("/files/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		b, ok := f.files[strings.TrimPrefix(r.URL.Path, "/files/")]
		f.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fleet) call(w http.ResponseWriter, r *http.Request) {
	var in map[string]any
	json.NewDecoder(r.Body).Decode(&in)
	f.mu.Lock()
	f.auth = append(f.auth, r.Header.Get("authorization"))
	out := map[string]any{"type": "reply", "id": in["id"], "ok": true, "trace": in["trace"]}
	switch in["type"] {
	case "builds.plan":
		f.asks = append(f.asks, in)
		if f.planRefuse != "" {
			out["ok"], out["error"] = false, f.planRefuse
		} else {
			out["result"] = f.plan
		}
	case "ledger.add":
		f.ledger = append(f.ledger, in)
		out["result"] = map[string]any{}
	case "redeem":
		if f.redeem != nil {
			for k, v := range f.redeem(in) {
				out[k] = v
			}
		}
	default:
		out["ok"], out["error"] = false, "unknown_request"
	}
	f.mu.Unlock()
	json.NewEncoder(w).Encode(out)
}

func (f *fleet) socket(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	_, b, err := c.Read(r.Context())
	if err != nil {
		return
	}
	var hello map[string]any
	json.Unmarshal(b, &hello)
	hello["path"] = r.URL.Path
	f.mu.Lock()
	f.hellos = append(f.hellos, hello)
	word := f.closeWith
	if word == "" {
		f.conn = c
	}
	f.mu.Unlock()
	if word != "" {
		c.Close(websocket.StatusPolicyViolation, word)
		return
	}
	for {
		_, b, err := c.Read(context.Background())
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["type"] == "reply" {
			f.replies <- m
		}
	}
}

func (f *fleet) locked(fn func()) { f.mu.Lock(); fn(); f.mu.Unlock() }

func (f *fleet) hellosN() int   { f.mu.Lock(); defer f.mu.Unlock(); return len(f.hellos) }
func (f *fleet) asksN() int     { f.mu.Lock(); defer f.mu.Unlock(); return len(f.asks) }
func (f *fleet) online() bool   { f.mu.Lock(); defer f.mu.Unlock(); return f.conn != nil }
func (f *fleet) ledgerHas(what string, sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, e := range f.ledger {
		if e["what"] == what && strings.Contains(fmt.Sprint(e["text"]), sub) {
			return true
		}
	}
	return false
}

// push — кадр keeper'у по соединению.
func (f *fleet) push(m map[string]any) {
	b, _ := json.Marshal(m)
	f.mu.Lock()
	c := f.conn
	f.mu.Unlock()
	if c == nil {
		f.t.Fatal("keeper не на связи")
	}
	c.Write(context.Background(), websocket.MessageText, b)
}

// ask — запрос keeper'у и его ответ.
func (f *fleet) ask(m map[string]any) map[string]any {
	f.push(m)
	select {
	case r := <-f.replies:
		return r
	case <-time.After(10 * time.Second):
		f.t.Fatal("keeper не ответил на " + fmt.Sprint(m["type"]))
		return nil
	}
}

func sha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func tgz(files map[string]string) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for name, text := range files {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(text)), Typeflag: tar.TypeReg})
		tw.Write([]byte(text))
	}
	tw.Close()
	zw.Close()
	return buf.Bytes()
}

// hostPlan — план со сборкой Host: поведение Host — mode; extra — ещё файлы архива. Файл Keeper в плане — тот, что уже стоит.
func (f *fleet) hostPlan(build int, mode string, extra map[string]string) map[string]any {
	files := map[string]string{"src/main.ts": mode + "\n"}
	for n, t := range extra {
		files[n] = t
	}
	b := tgz(files)
	name := fmt.Sprintf("host-%d.tgz", build)
	p := map[string]any{"build": build, "host": map[string]any{"url": f.srv.URL + "/files/" + name, "sha256": sha(b)},
		"keeper": map[string]any{"url": "", "sha256": ""}}
	f.locked(func() { f.files[name] = b })
	return p
}

func (f *fleet) setPlan(p any) { f.locked(func() { f.plan = p }) }

/* ===== Машина ===== */

type stand struct {
	t    *testing.T
	home string
	f    *fleet
}

func self() string { p, _ := os.Executable(); return p }

// newStand — папка флота на машине win: пропуск, keeper.json с адресом поддельного флота; Node — тестовый файл.
func newStand(t *testing.T) *stand {
	s := &stand{t: t, home: t.TempDir(), f: newFleet(t)}
	os.WriteFile(filepath.Join(s.home, "machine.key"), []byte(testKey+"\n"), 0o600)
	s.conf(s.f.srv.URL)
	t.Cleanup(func() { killHolders(s.home) })
	return s
}

func (s *stand) conf(base string) {
	b, _ := json.Marshal(map[string]any{"base": base, "machine": "win", "node": self()})
	os.WriteFile(filepath.Join(s.home, "keeper.json"), b, 0o600)
}

var fast = tuning{stop: 5 * time.Second, planWait: 5 * time.Second, ping: time.Second, pauseFirst: 30 * time.Millisecond,
	pauseMax: 200 * time.Millisecond, download: 10 * time.Second, holderWait: 20 * time.Second}

func (s *stand) start() keeperHandle { return s.startWith(fast) }

func (s *stand) startWith(tn tuning) keeperHandle {
	k, err := bootKeeper(s.home, tn)
	if err != nil {
		s.t.Fatal(err)
	}
	s.t.Cleanup(func() {
		select {
		case <-k.Done():
		default:
			k.Stop()
		}
	})
	return k
}

type heldFile struct {
	ID, Owner, Key, Tag string
	Pid, Holder, Port   int
}

func heldFiles(home string) []heldFile {
	var out []heldFile
	names, _ := filepath.Glob(filepath.Join(home, "procs", "*.json"))
	for _, n := range names {
		var h heldFile
		if b, err := os.ReadFile(n); err == nil && json.Unmarshal(b, &h) == nil {
			out = append(out, h)
		}
	}
	return out
}

func heldOf(home, id string) (heldFile, bool) {
	for _, h := range heldFiles(home) {
		if h.ID == id {
			return h, true
		}
	}
	return heldFile{}, false
}

// killHolders — убрать за стендом: держатели и их процессы.
func killHolders(home string) {
	for _, h := range heldFiles(home) {
		for _, pid := range []int{h.Pid, h.Holder} {
			if p, err := os.FindProcess(pid); err == nil {
				p.Kill()
			}
		}
	}
	time.Sleep(100 * time.Millisecond) // ОС отпускает файлы папки
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(30 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("не дождался: %s", what)
}

type stateView struct {
	Build int
	OS    string
	Host  struct {
		Build int
		State string
		Why   string
		Since int64
	}
}

func stateOf(k keeperHandle) stateView {
	var v stateView
	json.Unmarshal(k.StateJSON(), &v)
	return v
}

func running(k keeperHandle, build int) func() bool {
	return func() bool { v := stateOf(k); return v.Host.State == "running" && v.Host.Build == build }
}

// records — строки журнала машины.
func records(home string) []map[string]any {
	var out []map[string]any
	names, _ := filepath.Glob(filepath.Join(home, "journal", "*.jsonl"))
	for _, n := range names {
		b, _ := os.ReadFile(n)
		for _, l := range strings.Split(string(b), "\n") {
			var m map[string]any
			if json.Unmarshal([]byte(l), &m) == nil && m != nil {
				out = append(out, m)
			}
		}
	}
	return out
}

func count(home, msg string) int {
	n := 0
	for _, r := range records(home) {
		if r["msg"] == msg {
			n++
		}
	}
	return n
}

func has(home, msg string) bool { return count(home, msg) > 0 }

func journalText(home string) string {
	b, _ := json.Marshal(records(home))
	return string(b)
}

func hostEnv(home string) map[string]string {
	var m map[string]string
	b, _ := os.ReadFile(filepath.Join(home, "host", "data", "env.json"))
	json.Unmarshal(b, &m)
	return m
}

/* ===== Держатель по договору: [тип 1 байт][длина 4 байта, big-endian][данные] ===== */

type ownerConn struct{ c net.Conn }

func putFrame(w io.Writer, t byte, data []byte) error {
	b := make([]byte, 5+len(data))
	b[0] = t
	binary.BigEndian.PutUint32(b[1:5], uint32(len(data)))
	copy(b[5:], data)
	_, err := w.Write(b)
	return err
}

func getFrame(r io.Reader) (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	b := make([]byte, binary.BigEndian.Uint32(h[1:5]))
	_, err := io.ReadFull(r, b)
	return h[0], b, err
}

type heldHello struct{ Pid, Buffered int }

// attachHeld — подключиться хозяином по файлу держателя: ключ, затем hello.
func attachHeld(t *testing.T, h heldFile) (*ownerConn, heldHello) {
	t.Helper()
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(h.Port), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	putFrame(c, 'a', []byte(h.Key))
	typ, b, err := getFrame(c)
	if err != nil || typ != 'h' {
		t.Fatalf("держатель не поздоровался: %c %s %v", typ, b, err)
	}
	var hello heldHello
	json.Unmarshal(b, &hello)
	return &ownerConn{c}, hello
}

type heldExit struct {
	Code   *int
	Signal *string
	Stderr string
}

// read — вывод до кадра выхода или обрыва.
func (o *ownerConn) read(until string) (out string, exit *heldExit) {
	o.c.SetReadDeadline(time.Now().Add(20 * time.Second))
	for {
		typ, b, err := getFrame(o.c)
		if err != nil {
			return out, nil
		}
		switch typ {
		case 'o':
			out += string(b)
			if until != "" && strings.Contains(out, until) {
				return out, nil
			}
		case 'x':
			exit = &heldExit{}
			json.Unmarshal(b, exit)
			return out, exit
		}
	}
}

// holdApp — держатель с fakeApp под хозяином owner в папке home.
func holdApp(t *testing.T, home, id, owner string) heldFile {
	t.Helper()
	env := append(os.Environ(), "SB_HOME="+home, "SB_FLEET=home", "SB_MACHINE=win")
	if _, err := spawnHolder([]string{"--id", id, "--owner", owner, "--", self(), "app"}, env, 20*time.Second); err != nil {
		t.Fatal(err)
	}
	h, ok := heldOf(home, id)
	if !ok {
		t.Fatal("нет файла держателя " + id)
	}
	return h
}

func dialHolder(h heldFile) (net.Conn, error) {
	return net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(h.Port), 5*time.Second)
}
