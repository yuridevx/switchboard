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
	"os/exec"
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

// fakeApp — процесс под держателем: строка о старте, эхо каждой строки ввода, ввод закрыт — «bye» и выход 0. С KEEPER_TEST_SAID — после строки
// о старте вывод больше трубы и слово стенду «printed»: запись в трубу вернулась, значит, держатель уже прочитал начало вывода.
func fakeApp() {
	fmt.Printf("app start pid %d\n", os.Getpid())
	if u := os.Getenv("KEEPER_TEST_SAID"); u != "" {
		fmt.Println(strings.Repeat("x", 1<<20))
		say(u, "printed")
	}
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		fmt.Println("echo " + in.Text())
	}
	fmt.Println("bye")
}

// fakeHost — Host сборки: поведение — в тексте его main.ts. ok — живёт до закрытия ввода; crash — падает сразу; crashonce — падает один раз;
// session — как Host, запускает держателя сессии и живёт; deaf — конец ввода не слушает. Что сделал, говорит стенду по адресу флота:
// env — окружение записано, session — держатель сессии запущен.
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
	said := os.Getenv("SB_BASE") + "/said"
	say(said, "env")
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
			if _, err := spawnHolder([]string{"--id", "site@win", "--owner", "host", "--", me, "app"}, os.Environ(), time.Hour); err != nil {
				fmt.Fprintln(os.Stderr, "держатель сессии: "+err.Error())
				os.Exit(1)
			}
			say(said, "session")
		}
	case "deaf":
		// ждёт вечно своей трубы: ввод не слушает, сам не выходит — снимает держатель
		r, w, _ := os.Pipe()
		defer w.Close()
		r.Read(make([]byte, 1))
		return
	}
	io.Copy(io.Discard, os.Stdin)
}

// say — слово процесса стенду: что сделано; стенда нет — молча.
func say(url, what string) {
	if r, err := http.Get(url + "?what=" + what); err == nil {
		r.Body.Close()
	}
}

/* ===== Звонок стенда ===== */

// bell — звонок стенда: каждое событие — запрос или соединение флоту, ping, строка журнала Keeper, слово процесса — будит ожидания.
type bell struct {
	mu sync.Mutex
	ch chan struct{}
}

func newBell() *bell { return &bell{ch: make(chan struct{})} }

func (b *bell) ring() {
	b.mu.Lock()
	close(b.ch)
	b.ch = make(chan struct{})
	b.mu.Unlock()
}

// until — ждать, пока cond не станет верным: проверка — после каждого события; предел — срок теста.
func (b *bell) until(t *testing.T, what string, cond func() bool) {
	t.Helper()
	limit := testLimit(t)
	for {
		b.mu.Lock()
		ch := b.ch
		b.mu.Unlock()
		if cond() {
			return
		}
		select {
		case <-ch:
		case <-limit:
			t.Fatalf("не дождался: %s", what)
		}
	}
}

// testDeadline — срок теста (go test -timeout) с запасом на сообщение о сбое; срока нет — ноль.
func testDeadline(t *testing.T) time.Time {
	d, ok := t.Deadline()
	if !ok {
		return time.Time{}
	}
	return d.Add(-5 * time.Second)
}

// testLimit — срок теста каналом; срока нет — nil, ожидание без предела.
func testLimit(t *testing.T) <-chan time.Time {
	d := testDeadline(t)
	if d.IsZero() {
		return nil
	}
	return time.After(time.Until(d))
}

// waitChan — дождаться закрытия канала за срок теста.
func waitChan(t *testing.T, what string, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-testLimit(t):
		t.Fatalf("не дождался: %s", what)
	}
}

/* ===== Поддельный флот ===== */

type fleet struct {
	t     *testing.T
	srv   *httptest.Server
	b     *bell
	mu    sync.Mutex
	plan  any // ответ builds.plan; nil — null
	files map[string][]byte
	// что видел флот
	asks    []map[string]any
	auth    []string
	ledger  []map[string]any
	hellos  []map[string]any
	conns   []*linkView // соединения по порядку hello
	said    []string    // слова процессов стенда
	conn    *websocket.Conn
	replies chan map[string]any
	// как отвечает
	closeWith  string // закрыть новое соединение этим словом
	pongs      int    // сколько ping подтвердить pong; дальше вместо pong — кадр: соединение есть, но сеть его не подтверждает. -1 — все
	planRefuse string
	redeem     func(f map[string]any) map[string]any
}

// linkView — одно соединение глазами флота: ping по нему и кончилось ли его чтение.
type linkView struct {
	pings int
	over  bool
}

func newFleet(t *testing.T) *fleet {
	f := &fleet{t: t, b: newBell(), files: map[string][]byte{}, replies: make(chan map[string]any, 16), pongs: -1}
	mux := http.NewServeMux()
	mux.HandleFunc("/call", f.call)
	mux.HandleFunc("/m/", f.socket)
	mux.HandleFunc("/said", func(w http.ResponseWriter, r *http.Request) {
		f.locked(func() { f.said = append(f.said, r.URL.Query().Get("what")) })
		f.b.ring()
	})
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
	f.b.ring()
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
	view := &linkView{}
	f.mu.Lock()
	f.hellos = append(f.hellos, hello)
	f.conns = append(f.conns, view)
	word := f.closeWith
	if word == "" {
		f.conn = c
	}
	f.mu.Unlock()
	f.b.ring()
	defer func() { f.locked(func() { view.over = true }); f.b.ring() }()
	if word != "" {
		c.Close(websocket.StatusPolicyViolation, word)
		return
	}
	for {
		_, b, err := c.Read(context.Background())
		if err != nil {
			return
		}
		if string(b) == "ping" {
			// как автоответ relay: "ping" → "pong"; флот, который pong больше не шлёт, шлёт кадр — живость доказывает только pong
			f.mu.Lock()
			view.pings++
			answer := f.pongs != 0
			if f.pongs > 0 {
				f.pongs--
			}
			f.mu.Unlock()
			if answer {
				c.Write(context.Background(), websocket.MessageText, []byte("pong"))
			} else {
				c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"noop"}`))
			}
			f.b.ring()
			continue
		}
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["type"] == "reply" {
			f.replies <- m
		}
	}
}

func (f *fleet) locked(fn func()) { f.mu.Lock(); fn(); f.mu.Unlock() }

func (f *fleet) hellosN() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.hellos) }
func (f *fleet) asksN() int   { f.mu.Lock(); defer f.mu.Unlock(); return len(f.asks) }
func (f *fleet) online() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.conn != nil }

func (f *fleet) saidHas(what string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, w := range f.said {
		if w == what {
			return true
		}
	}
	return false
}
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

// ask — запрос keeper'у и его ответ за срок теста.
func (f *fleet) ask(m map[string]any) map[string]any {
	f.push(m)
	select {
	case r := <-f.replies:
		return r
	case <-testLimit(f.t):
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
	t     *testing.T
	home  string
	f     *fleet
	mu    sync.Mutex
	lines []map[string]any // строки журнала Keeper стенда в порядке записи — из tap; строки держателей — только в файле
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

// fast — пределы стенда. Срок, который проверяется (ping, «закрой ввод»), тест задаёт сам; пределы сбоев — дольше срока теста и на медленной
// машине не срабатывают; паузы переподключения короткие — тест ждёт переподключения.
var fast = tuning{stop: time.Hour, planWait: time.Hour, ping: time.Hour, pauseFirst: 30 * time.Millisecond,
	pauseMax: 200 * time.Millisecond, download: time.Hour, holderWait: time.Hour}

func (s *stand) start() keeperHandle { return s.startWith(fast) }

func (s *stand) startWith(tn tuning) keeperHandle {
	tn.tap = s.tap
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

// killHolders — убрать за стендом: держатели и их процессы; возврат — когда вышли: ОС отпускает файлы папки.
func killHolders(home string) {
	for _, h := range heldFiles(home) {
		for _, pid := range []int{h.Pid, h.Holder} {
			if p, err := os.FindProcess(pid); err == nil {
				p.Kill()
			}
			waitGone(pid)
		}
	}
}

// tap — строки журнала Keeper стенда: в память и звонок.
func (s *stand) tap(b []byte) {
	s.mu.Lock()
	for _, l := range bytes.Split(b, []byte("\n")) {
		var m map[string]any
		if json.Unmarshal(l, &m) == nil && m != nil {
			s.lines = append(s.lines, m)
		}
	}
	s.mu.Unlock()
	s.f.b.ring()
}

// n — строк журнала Keeper с этим msg и полями kv (имя, значение).
func (s *stand) n(msg string, kv ...any) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := 0
next:
	for _, l := range s.lines {
		if l["msg"] != msg {
			continue
		}
		for i := 0; i+1 < len(kv); i += 2 {
			if fmt.Sprint(l[kv[i].(string)]) != fmt.Sprint(kv[i+1]) {
				continue next
			}
		}
		c++
	}
	return c
}

// line — есть строка журнала Keeper с этим msg, в которой есть sub.
func (s *stand) line(msg, sub string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.lines {
		if l["msg"] == msg && strings.Contains(fmt.Sprint(l), sub) {
			return true
		}
	}
	return false
}

// until — ждать события стенда: строки журнала Keeper, запроса или соединения флоту, слова процесса.
func (s *stand) until(what string, cond func() bool) {
	s.t.Helper()
	s.f.b.until(s.t, what, cond)
}

// planned — кадр plan.changed и строка plan этого вопроса (по trace): актор взял план — всё, что он брал до него, исполнено, а план, который
// ждал, заменён этим. Барьер актора: зовётся, когда других вопросов о плане в пути нет; план флота — тот, что уже исполнен. Keeper вышел —
// барьера не будет: ожидание кончается строкой keeper_exit.
func (s *stand) planned() {
	s.t.Helper()
	n, exits := s.f.asksN(), s.n("keeper_exit")
	s.f.push(map[string]any{"type": "plan.changed"})
	s.until("вопрос о плане", func() bool { return s.f.asksN() > n })
	s.f.mu.Lock()
	trace := s.f.asks[n]["trace"]
	s.f.mu.Unlock()
	s.until(fmt.Sprintf("план вопроса %v взят", trace), func() bool { return s.n("plan", "trace", trace) > 0 || s.n("keeper_exit") > exits })
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

// attachHeld — подключиться хозяином по файлу держателя: ключ, затем hello; соединение живёт не дольше срока теста.
func attachHeld(t *testing.T, h heldFile) (*ownerConn, heldHello) {
	t.Helper()
	c, err := dialHolder(h)
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(testDeadline(t))
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

// holdApp — держатель с fakeApp под хозяином owner в папке home; env — ещё окружение. Держателя запускает стенд: возврат — его строка о себе
// и канал его выхода.
func holdApp(t *testing.T, home, id, owner string, env ...string) (heldFile, <-chan struct{}) {
	t.Helper()
	cmd := exec.Command(self(), "hold", "--id", id, "--owner", owner, "--", self(), "app")
	cmd.Env = append(append(os.Environ(), "SB_HOME="+home, "SB_FLEET=home", "SB_MACHINE=win"), env...)
	out, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		t.Fatal(err)
	}
	l, _ := bufio.NewReader(out).ReadString('\n')
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	var h heldFile
	if err := json.Unmarshal([]byte(l), &h); err != nil {
		t.Fatalf("держатель не написал о себе: %q", l)
	}
	return h, exited
}

func dialHolder(h heldFile) (net.Conn, error) {
	return net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(h.Port))
}
