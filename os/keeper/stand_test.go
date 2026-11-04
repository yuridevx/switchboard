package main

// Стенд keeper: настоящие keeper и держатели на временной папке, поддельный relay (вебсокет), поддельные ссылки на архивы. Приложение, держатель
// и новый файл keeper — этот же тестовый файл в другой роли. Раскладка папки, файлы держателей и протокол держателя здесь записаны заново, по
// контракту: стенд с кодом их не делит, настоящий код проверяется на тех же байтах, что видит Host.
import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
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
			// предел ожидания хозяина — короче для эталонов держателя без хозяина
			if d, err := time.ParseDuration(os.Getenv("KEEPER_TEST_OWNER_WAIT")); err == nil {
				setOwnerWait(d)
			}
			// держатель завис до строки о себе: pid — в файл для проверки, что хозяин его убил
			if os.Getenv("KEEPER_TEST_HOLD_SILENT") == "1" {
				os.WriteFile(filepath.Join(os.Getenv("SWITCHBOARD_HOME"), "silent-pid"), []byte(strconv.Itoa(os.Getpid())), 0o644)
				time.Sleep(10 * time.Minute)
			}
			main()
			return
		case "keeper":
			// настоящий вход файла keeper: аргументы — как у него
			os.Args = append([]string{os.Args[0]}, os.Args[2:]...)
			main()
			return
		case "app":
			fakeApp(os.Args[2:])
			return
		case "version":
			if os.Getenv("KEEPER_TEST_VERSION_HANG") == "1" {
				time.Sleep(10 * time.Minute)
			}
			fmt.Println(os.Getenv("KEEPER_TEST_VERSION"))
			return
		case "setup":
			// как npm на Windows: записать полный путь своей папки — ссылки workspaces держат его
			wd, _ := os.Getwd()
			os.WriteFile("setup-dir", []byte(wd), 0o644)
			return
		case "slowsetup":
			// долгий setup, как npm ci у Host: метка начала — стенду, чтобы уронить прежнюю версию посреди установки
			os.WriteFile("setup-started", nil, 0o644)
			time.Sleep(2 * time.Second)
			return
		case "hangsetup":
			// setup завис, как npm ci без сети
			time.Sleep(10 * time.Minute)
			return
		case "tailapp":
			// последняя строка без перевода строки — и выход с ошибкой
			fmt.Print("последние слова")
			os.Exit(1)
		case "badsetup":
			// setup упал, как npm ci без пакета
			fmt.Fprintln(os.Stderr, "npm ERR! нет пакета")
			os.Exit(1)
		}
		// под именем Node: свои аргументы — в файл; ввод закрыт — выход
		if f := os.Getenv("KEEPER_TEST_NODE"); f != "" {
			h, _ := os.OpenFile(f, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			fmt.Fprintln(h, strings.Join(os.Args[1:], "|"))
			h.Close()
			io.Copy(io.Discard, os.Stdin)
			return
		}
	}
	os.Setenv("KEEPER_TEST_CHILD", "1")
	os.Exit(m.Run())
}

// fakeApp — приложение: строка о старте, ввод закрыт — «bye» и выход 0; stubborn — конец ввода не слушает;
// deaf — ввод не читает вовсе (завис); env — строка со своим окружением от keeper; chatty — строки без пауз;
// echo — отвечает на каждую строку ввода; parent — запускает потомка, который держит трубу вывода.
func fakeApp(args []string) {
	mode := ""
	if len(args) > 0 {
		mode = args[0]
	}
	fmt.Printf("app %s start pid %d\n", os.Getenv("SWITCHBOARD_VERSION"), os.Getpid())
	if mode == "deaf" {
		time.Sleep(2 * time.Minute)
		return
	}
	if mode == "parent" {
		self, _ := os.Executable()
		ch := exec.Command(self, "app", "deaf")
		ch.Stdout = os.Stdout
		ch.Env = os.Environ()
		if err := ch.Start(); err == nil {
			fmt.Printf("child %d\n", ch.Process.Pid)
		}
	}
	if mode == "host" {
		// как Host: держатель сессии запускает сама часть, он переживает её смену версии
		self, _ := os.Executable()
		if f, err := holdProc(os.Getenv("SWITCHBOARD_HOME"), holdReq{ID: "site@win", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}}); err == nil {
			fmt.Printf("session %d\n", f.Pid)
		}
	}
	if mode == "args" {
		fmt.Println("args " + strings.Join(args, " "))
	}
	if mode == "chatty" {
		go func() {
			for i := 0; ; i++ {
				fmt.Printf("tick %d\n", i)
			}
		}()
	}
	if mode == "env" {
		var kv []string
		for _, n := range []string{"SWITCHBOARD_MACHINE", "SWITCHBOARD_VERSION", "SWITCHBOARD_DATA", "SWITCHBOARD_HOLDER", "SWITCHBOARD_HOME", "SWITCHBOARD_RELAY", "SWITCHBOARD_WORKERS", "SITE"} {
			kv = append(kv, n+"="+os.Getenv(n))
		}
		wd, _ := os.Getwd()
		kv = append(kv, "CWD="+wd)
		fmt.Println("env " + strings.Join(kv, " "))
	}
	fmt.Fprintln(os.Stderr, "app: stderr line")
	br := bufio.NewReader(os.Stdin)
	for {
		l, err := br.ReadString('\n')
		if mode == "echo" && l != "" {
			fmt.Print("echo " + l)
		}
		if err != nil {
			break
		}
	}
	if mode == "stubborn" {
		time.Sleep(10 * time.Minute)
	}
	fmt.Println("bye")
}

/* ===== папка машины и файл держателя: контракт на диске ===== */

func planFile(home string) string      { return filepath.Join(home, "plan.json") }
func confFile(home string) string      { return filepath.Join(home, "keeper.json") }
func partFolder(home, n string) string { return filepath.Join(home, "parts", n) }
func verDir(home, n, v string) string  { return filepath.Join(partFolder(home, n), v) }
func stampFile(dir string) string      { return filepath.Join(dir, "release.sha256") }
func heldDir(home string) string       { return filepath.Join(home, "procs") }
func heldPath(home, id string) string  { return filepath.Join(heldDir(home), id+".json") }
func isThere(p string) bool            { _, err := os.Stat(p); return err == nil }
func archDir() string                  { return runtime.GOOS + "-" + runtime.GOARCH }

func binName(s string) string {
	if runtime.GOOS == "windows" {
		return s + ".exe"
	}
	return s
}

// ourVersion — версия из манифеста: так отвечает файл, собранный без номера.
var ourVersion = func() string {
	var m struct{ Version string }
	b, _ := os.ReadFile("module.json")
	json.Unmarshal(b, &m)
	return m.Version
}()

func saveConf(home string, m map[string]any) {
	os.MkdirAll(home, 0o700)
	b, _ := json.MarshalIndent(m, "", "  ")
	os.WriteFile(confFile(home), append(b, '\n'), 0o600)
}

func loadConf(home string) (map[string]any, error) {
	m := map[string]any{}
	b, err := os.ReadFile(confFile(home))
	if err != nil {
		return m, err
	}
	return m, json.Unmarshal(b, &m)
}

func confWorkers(m map[string]any) map[string]any {
	w, _ := m["workers"].(map[string]any)
	return w
}

type heldFile struct {
	ID     string `json:"id"`
	Owner  string `json:"owner"`
	Pid    int    `json:"pid"`
	Holder int    `json:"holder"`
	Port   int    `json:"port"`
	Key    string `json:"key"`
	Tag    string `json:"tag,omitempty"`
}

func putHeldFile(home string, f heldFile) {
	os.MkdirAll(heldDir(home), 0o700)
	b, _ := json.Marshal(f)
	os.WriteFile(heldPath(home, f.ID), b, 0o600)
}

func heldFiles(home string) []heldFile {
	es, _ := os.ReadDir(heldDir(home))
	var out []heldFile
	for _, e := range es {
		var f heldFile
		b, err := os.ReadFile(filepath.Join(heldDir(home), e.Name()))
		if err == nil && json.Unmarshal(b, &f) == nil && f.ID != "" {
			out = append(out, f)
		}
	}
	return out
}

/* ===== протокол держателя: заморожен, Host говорит на тех же байтах ===== */

const (
	kAuth  = 'a'
	kInput = 'i'
	kClose = 'c'
	kKill  = 'k'
	kHello = 'h'
	kOut   = 'o'
	kExit  = 'x'
	kError = 'e'
)

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
	if _, err := io.ReadFull(r, b); err != nil {
		return 0, nil, err
	}
	return h[0], b, nil
}

type heldHello struct {
	Pid      int `json:"pid"`
	Buffered int `json:"buffered"`
}

type heldExit struct {
	Code   *int    `json:"code"`
	OSStop bool    `json:"os_stop,omitempty"`
	Signal *string `json:"signal"`
	Stderr string  `json:"stderr"`
}

// ownerConn — хозяин держателя глазами Host.
type ownerConn struct{ c net.Conn }

func (o *ownerConn) send(t byte, b []byte) error { return putFrame(o.c, t, b) }
func (o *ownerConn) closeInput() error           { return putFrame(o.c, kClose, nil) }
func (o *ownerConn) kill() error                 { return putFrame(o.c, kKill, nil) }
func (o *ownerConn) Close()                      { o.c.Close() }

func (o *ownerConn) read(onOut func([]byte)) (*heldExit, error) {
	br := bufio.NewReader(o.c)
	for {
		t, b, err := getFrame(br)
		if err != nil {
			return nil, err
		}
		switch t {
		case kOut:
			onOut(b)
		case kExit:
			var x heldExit
			json.Unmarshal(b, &x)
			return &x, nil
		}
	}
}

// holdReq — что запустить под держателем.
type holdReq struct {
	ID    string
	Owner string
	Tag   string
	Env   []string
	Cmd   []string
}

// holdProc — держатель командой файла, как его запускает Host: первая строка stdout — о себе.
func holdProc(home string, s holdReq) (heldFile, error) {
	self, err := os.Executable()
	if err != nil {
		return heldFile{}, err
	}
	args := []string{"hold", "--id", s.ID, "--owner", s.Owner}
	if s.Tag != "" {
		args = append(args, "--tag", s.Tag)
	}
	cmd := exec.Command(self, append(append(args, "--"), s.Cmd...)...)
	cmd.Env = append(append([]string{}, s.Env...), "SWITCHBOARD_HOME="+home)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return heldFile{}, err
	}
	detachProc(cmd)
	if err := cmd.Start(); err != nil {
		return heldFile{}, err
	}
	l, err := bufio.NewReader(out).ReadString('\n')
	go cmd.Wait()
	if err != nil {
		return heldFile{}, fmt.Errorf("держатель не запустился: %w", err)
	}
	var r struct {
		Port int    `json:"port"`
		Key  string `json:"key"`
		Pid  int    `json:"pid"`
	}
	if err := json.Unmarshal([]byte(l), &r); err != nil {
		return heldFile{}, err
	}
	return heldFile{ID: s.ID, Owner: s.Owner, Tag: s.Tag, Pid: r.Pid, Port: r.Port, Key: r.Key}, nil
}

// attachHeld — подключиться хозяином: ключ, ответ — pid и накопленное.
func attachHeld(f heldFile) (*ownerConn, heldHello, error) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port), 5*time.Second)
	if err != nil {
		return nil, heldHello{}, err
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if err := putFrame(c, kAuth, []byte(f.Key)); err != nil {
		c.Close()
		return nil, heldHello{}, err
	}
	t, b, err := getFrame(c)
	if err != nil {
		c.Close()
		return nil, heldHello{}, err
	}
	c.SetDeadline(time.Time{})
	if t == kError {
		c.Close()
		return nil, heldHello{}, fmt.Errorf("держатель отказал: %s", b)
	}
	var hh heldHello
	json.Unmarshal(b, &hh)
	return &ownerConn{c: c}, hh, nil
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
	asks   int              // вопросов releases.plan
	silent int              // столько первых вопросов остаются без ответа — «выпуски» молчат
	asked  []map[string]any // вопросы releases.plan как пришли
	refuse string           // не пусто — «выпуски» отвечают на вопрос отказом с этим словом
	hello  map[string]any   // последний hello keeper
	opens  int              // принятых hello
	path   string           // путь вебсокета последнего входа: /m/<машина>
	keys   []string         // пропуска в POST к Worker'ам
}

// planReply — ответ «Выпусков» на вопрос о плане: план, отказ словом или молчание.
func (r *fakeRelay) planReply(f map[string]any) (map[string]any, bool) {
	r.mu.Lock()
	p := r.plan
	r.asks++
	r.asked = append(r.asked, f)
	quiet := r.asks <= r.silent
	word := r.refuse
	r.mu.Unlock()
	if quiet {
		return nil, false
	}
	if word != "" {
		return map[string]any{"type": "reply", "id": f["id"], "ok": false, "error": word}, true
	}
	return map[string]any{"type": "reply", "id": f["id"], "ok": true, "result": p}, true
}

// serveWorker — POST к Worker'ам флота: /releases (план), /ledger (журнал), /gate (приём приглашения).
func (r *fakeRelay) serveWorker(w http.ResponseWriter, req *http.Request) {
	var f map[string]any
	json.NewDecoder(req.Body).Decode(&f)
	r.mu.Lock()
	r.keys = append(r.keys, fmt.Sprint(f["key"]))
	r.mu.Unlock()
	switch req.URL.Path {
	case "/releases":
		out, ok := r.planReply(f)
		if !ok {
			<-req.Context().Done()
			return
		}
		json.NewEncoder(w).Encode(out)
	case "/ledger":
		r.mu.Lock()
		r.ledger = append(r.ledger, f)
		r.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case "/gate":
		inv := fmt.Sprint(f["invite"])
		switch {
		case strings.HasPrefix(inv, "win1."):
			json.NewEncoder(w).Encode(map[string]any{"type": "reply", "id": f["id"], "ok": true, "result": map[string]any{"key": "host.win.win1.SECRET"}})
		case strings.HasPrefix(inv, "phn1."):
			json.NewEncoder(w).Encode(map[string]any{"type": "reply", "id": f["id"], "ok": true, "result": map[string]any{"key": "client.phone.phn1.SECRET"}})
		default:
			json.NewEncoder(w).Encode(map[string]any{"type": "reply", "id": f["id"], "ok": false, "error": "bad_invite"})
		}
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// workerURL — адрес Worker'а стенда.
func (r *fakeRelay) workerURL(name string) string { return r.srv.URL + "/" + name }

func newFakeRelay(t *testing.T) *fakeRelay {
	r := &fakeRelay{t: t, reply: map[string]chan map[string]any{}, opened: make(chan struct{}, 10)}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodPost {
			r.serveWorker(w, req)
			return
		}
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
		r.hello = hello
		r.opens++
		r.path = req.URL.Path
		r.mu.Unlock()
		ws.Write(ctx, websocket.MessageText, []byte(`{"type":"roster","machines":[],"sessions":[],"clients":[],"workers":[]}`))
		select {
		case r.opened <- struct{}{}:
		default:
		}
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

func testID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ask — запрос keeper и его ответ.
func (r *fakeRelay) ask(f map[string]any) map[string]any {
	id := testID()
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

// setSilent — первые n вопросов о плане остаются без ответа.
func (r *fakeRelay) setSilent(n int) {
	r.mu.Lock()
	r.silent = n
	r.mu.Unlock()
}

// planAsks — сколько раз keeper спросил план.
func (r *fakeRelay) planAsks() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.asks
}

// firstAsk — первый вопрос releases.plan, как пришёл.
func (r *fakeRelay) firstAsk() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.asked) == 0 {
		return nil
	}
	return r.asked[0]
}

// setRefuse — «выпуски» отвечают на вопрос о плане отказом word.
func (r *fakeRelay) setRefuse(word string) {
	r.mu.Lock()
	r.refuse = word
	r.mu.Unlock()
}

// drop — relay оборвал соединение keeper.
func (r *fakeRelay) drop() {
	r.mu.Lock()
	ws := r.ws
	r.mu.Unlock()
	ws.CloseNow()
}

// ledgerHas — в журнале флота есть строка ev text, начинающаяся с prefix.
func (r *fakeRelay) ledgerHas(prefix string) bool {
	for _, e := range r.ledgerEvs() {
		if strings.HasPrefix(e, prefix) {
			return true
		}
	}
	return false
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

// seen — что relay видел от keeper: последний hello и сколько hello принято.
func (r *fakeRelay) seen() (map[string]any, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.hello, r.opens
}

// ledgerCount — строк журнала флота ev text, начинающихся с prefix.
func (r *fakeRelay) ledgerCount(prefix string) int {
	n := 0
	for _, e := range r.ledgerEvs() {
		if strings.HasPrefix(e, prefix) {
			n++
		}
	}
	return n
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

// expire — ссылки истекли: архивов по ним больше нет (ссылка в плане живёт час).
func (l *links) expire() {
	l.mu.Lock()
	l.m = map[string][]byte{}
	l.mu.Unlock()
}

// part — архив части в ссылках и запись плана для неё.
func (l *links) part(name, version string, fs files, extra map[string]any) map[string]any {
	return l.partTgz(name, version, tgz(fs), extra)
}

// partTgz — то же с готовым архивом.
func (l *links) partTgz(name, version string, b []byte, extra map[string]any) map[string]any {
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

// appFiles — app.json приложения: этот тестовый файл в роли app.
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
	// одна карта адресов: relay — адрес Worker'а relay (http стенда), объект машины — ws того же адреса
	saveConf(home, map[string]any{"workers": map[string]any{"relay": "http" + strings.TrimPrefix(s.relay.url(), "ws"), "releases": s.relay.workerURL("releases"), "ledger": s.relay.workerURL("ledger")}})
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	return s
}

// start — keeper; подмена себя не выходит из процесса теста.
func (s *stand) start() keeperHandle { return s.startWith(tuning{}) }

// startWith — keeper с пределами стенда.
func (s *stand) startWith(tn tuning) keeperHandle { return bootOn(s.t, s.home, tn) }

// bootOn — keeper на папке home; остановка — в конце теста.
func bootOn(t *testing.T, home string, tn tuning) keeperHandle {
	t.Helper()
	k, err := bootKeeper(home, tn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(k.Stop)
	return k
}

// relayHome — папка машины с relay по адресу url и без других Worker'ов.
func relayHome(t *testing.T, url string) string {
	t.Helper()
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "machine.key"), []byte("host.win.ab12.sig\n"), 0o600)
	saveConf(home, map[string]any{"workers": map[string]any{"relay": url}})
	t.Setenv("SWITCHBOARD_HOME", home)
	return home
}

func killHolders(home string) {
	var pids []int
	for _, f := range heldFiles(home) {
		if c, _, err := attachHeld(f); err == nil {
			c.kill()
			c.read(func([]byte) {})
			c.Close()
		}
		// держатель, к которому не подключиться, — уборка теста убивает по pid
		for _, p := range []int{f.Pid, f.Holder} {
			if pr, err := os.FindProcess(p); err == nil && alive(p) {
				pr.Kill()
			}
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

// partView — часть в ответе keeper.state.
type partView struct {
	Part     string `json:"part"`
	Version  string `json:"version"`
	State    string `json:"state"`
	Pid      int    `json:"pid"`
	Restarts int    `json:"restarts"`
	Error    string `json:"error"`
}

type stateView struct {
	Rev   int        `json:"rev"`
	Parts []partView `json:"parts"`
}

// stateOf — keeper.state: те же байты, что уходят в ответ по relay (связи может не быть).
func stateOf(k keeperHandle) stateView {
	var s stateView
	json.Unmarshal(k.StateJSON(), &s)
	return s
}

func partOf(k keeperHandle, name string) partView {
	for _, p := range stateOf(k).Parts {
		if p.Part == name {
			return p
		}
	}
	return partView{}
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

// planMsg — кадр releases.plan в том виде, в каком его шлют «выпуски» через relay: конверт v1, from ставит relay.
func planMsg(rev int, parts ...map[string]any) map[string]any {
	f := plan1(rev, parts...)
	f["type"], f["v"], f["to"], f["from"] = "releases.plan", 1, ".keeper@win", ".releases"
	return f
}

// savedPlan — plan.json на диске.
type savedPlan struct {
	Rev   int `json:"rev"`
	Parts []struct {
		Version string `json:"version"`
	} `json:"parts"`
}

func plan1(rev int, parts ...map[string]any) map[string]any {
	ps := []any{}
	for _, p := range parts {
		ps = append(ps, p)
	}
	return map[string]any{"rev": rev, "parts": ps}
}

// journalLine — первая строка журнала с подстрокой s, разобранная.
func journalLine(home, s string) map[string]any {
	ms, _ := filepath.Glob(filepath.Join(home, "journal", "*.jsonl"))
	for _, m := range ms {
		b, _ := os.ReadFile(m)
		for _, l := range strings.Split(string(b), "\n") {
			if strings.Contains(l, s) {
				var r map[string]any
				json.Unmarshal([]byte(l), &r)
				return r
			}
		}
	}
	return nil
}

// runKeeper — этот тестовый файл в роли файла keeper: настоящий main с args, SWITCHBOARD_HOME — home, stdin — in.
func runKeeper(t *testing.T, home, in string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	self, _ := os.Executable()
	cmd := exec.Command(self, append([]string{"keeper"}, args...)...)
	cmd.Env = append(os.Environ(), "SWITCHBOARD_HOME="+home)
	cmd.Stdin = strings.NewReader(in)
	var o, e strings.Builder
	cmd.Stdout, cmd.Stderr = &o, &e
	err := cmd.Run()
	var xe *exec.ExitError
	if err != nil && !errors.As(err, &xe) {
		t.Fatalf("keeper %v: %v", args, err)
	}
	return cmd.ProcessState.ExitCode(), o.String(), e.String()
}
