package main

// Держатель — режим того же файла keeper: держит один процесс.
//
//	keeper hold --id <id> --owner keeper|host [--cwd <папка>] [--detach-children] -- <команда> <аргументы…>
//
// Запускает процесс с трубами ввода-вывода в своём задании ОС «закрыл — убей» (умер держатель — умер процесс),
// слушает 127.0.0.1 на порту от ОС, пишет о себе ~/.switchboard/procs/<id>.json (адрес, ключ, pid, хозяин) и одной
// строкой то же — в свой stdout, после чего stdout закрывает. Подключается к нему только хозяин, по ключу.
// Пока хозяина нет — копит вывод и код выхода. Процесс вышел, выход отдан хозяину и хозяин закрыл соединение — файл
// убран, держатель вышел.
// Ошибки процесса (stderr) — строками в журнал машины.
import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// holdFile — файл держателя в procs/.
type holdFile struct {
	ID     string `json:"id"`
	Owner  string `json:"owner"`
	Pid    int    `json:"pid"`
	Holder int    `json:"holder"`
	Port   int    `json:"port"`
	Key    string `json:"key"`
	Tag    string `json:"tag,omitempty"`
}

func procsDir(home string) string { return filepath.Join(home, "procs") }

// holdPath — файл держателя; id — имя части или позывной сессии, без путей.
func holdPath(home, id string) string { return filepath.Join(procsDir(home), id+".json") }

func validID(id string) bool {
	return id != "" && id != "." && id != ".." && !strings.ContainsAny(id, `/\:*?"<>|`)
}

type holder struct {
	id, owner string
	home      string
	j         *Journal
	key       string
	ln        net.Listener
	cmd       *exec.Cmd
	osh       *osHandle
	stdin     io.WriteCloser

	mu      sync.Mutex
	conn    net.Conn
	buf     []byte
	exit    *exitInfoJSON // процесс вышел и всё прочитано
	forced  bool
	osStop  bool // ввод закрыт по сигналу остановки от ОС
	lastErr string
	exitTo  net.Conn   // хозяин, которому отдан выход: держатель выходит, когда он закрыл соединение
	outMu   sync.Mutex // порядок записи в соединение
	done    chan struct{}
	// выход держателя — один раз: его зовут и конец чтения хозяина, и отданный выход
	finishOnce sync.Once

	// ввод процесса: очередь и свой писатель — кадры хозяина читаются, даже когда процесс не читает ввод
	inMu   sync.Mutex
	inQ    [][]byte
	inEnd  bool // «закрой ввод» — после очереди
	inWake chan struct{}
}

// runHold — вход режима держателя; код выхода держателя.
func runHold(args []string) int {
	fs := flag.NewFlagSet("hold", flag.ContinueOnError)
	id := fs.String("id", "", "имя части или позывной сессии")
	owner := fs.String("owner", "", "хозяин: keeper или host")
	cwd := fs.String("cwd", "", "рабочая папка процесса")
	detach := fs.Bool("detach-children", false, "дети процесса — не в задании держателя")
	tag := fs.String("tag", "", "метка хозяина: версия части")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cmdline := fs.Args()
	if !validID(*id) || (*owner != "keeper" && *owner != "host") || len(cmdline) == 0 {
		fmt.Fprintln(os.Stderr, "hold: нужны --id, --owner keeper|host и команда после --")
		return 2
	}
	home, err := homeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "hold:", err)
		return 1
	}
	j := newJournal(filepath.Join(home, "journal"), machineOf(readKey(home)), nil)
	j.who = "holder"
	// строки держателя — под тем, чей процесс он держит: часть машины или сессия Host
	if *owner == "keeper" {
		j.part = *id
	} else {
		j.part, j.callsign = "host", *id
	}
	h, err := startHolder(home, *id, *owner, *tag, *cwd, *detach, cmdline, j)
	if err != nil {
		j.stop("hold_failed", "держатель «"+*id+"» не запустил процесс: "+err.Error(), "id", *id)
		fmt.Fprintln(os.Stderr, "hold:", err)
		return 1
	}
	// одна строка о себе — тому, кто запустил; дальше stdout не нужен
	b, _ := json.Marshal(map[string]any{"port": h.ln.Addr().(*net.TCPAddr).Port, "key": h.key, "pid": h.cmd.Process.Pid})
	os.Stdout.Write(append(b, '\n'))
	os.Stdout.Close()
	return h.serve()
}

func startHolder(home, id, owner, tag, cwd string, detach bool, cmdline []string, j *Journal) (*holder, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(cmdline[0], cmdline[1:]...)
	cmd.Dir = cwd
	inR, inW, err := os.Pipe()
	if err != nil {
		ln.Close()
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		ln.Close()
		return nil, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		ln.Close()
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	setProcAttr(cmd)
	if err := cmd.Start(); err != nil {
		ln.Close()
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		return nil, err
	}
	inR.Close()
	outW.Close()
	errW.Close()
	osh, err := afterStart(cmd.Process, detach)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		ln.Close()
		return nil, err
	}
	h := &holder{id: id, owner: owner, home: home, j: j, key: hex.EncodeToString(raw), ln: ln, cmd: cmd, osh: osh, stdin: inW,
		done: make(chan struct{}), inWake: make(chan struct{}, 1)}
	f := holdFile{ID: id, Owner: owner, Pid: cmd.Process.Pid, Holder: os.Getpid(), Port: ln.Addr().(*net.TCPAddr).Port, Key: h.key, Tag: tag}
	if err := writeHoldFile(home, f); err != nil {
		osh.killTree()
		cmd.Wait()
		ln.Close()
		return nil, err
	}
	j.note("hold", "id", id, "owner", owner, "pid", cmd.Process.Pid, "cmd", cmdline)
	go h.pump(outR, errR)
	go h.writeInput()
	return h, nil
}

// input — ввод процесса в очередь; end — «закрой ввод» после всего, что в очереди.
func (h *holder) input(b []byte, end bool) {
	h.inMu.Lock()
	if b != nil {
		h.inQ = append(h.inQ, b)
	}
	if end {
		h.inEnd = true
	}
	h.inMu.Unlock()
	select {
	case h.inWake <- struct{}{}:
	default:
	}
}

// writeInput — писатель трубы ввода: процесс не читает ввод — ждёт только он, не цикл кадров хозяина.
func (h *holder) writeInput() {
	for {
		h.inMu.Lock()
		q, end := h.inQ, h.inEnd
		h.inQ = nil
		h.inMu.Unlock()
		for _, b := range q {
			h.stdin.Write(b) // ошибка — процесс ушёл, остальное писать некуда
		}
		if len(q) > 0 {
			continue
		}
		if end {
			h.stdin.Close()
			return
		}
		select {
		case <-h.inWake:
		case <-h.done:
			return
		}
	}
}

func writeHoldFile(home string, f holdFile) error {
	if err := os.MkdirAll(procsDir(home), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(f, "", "  ")
	return writeFileAtomic(holdPath(home, f.ID), append(b, '\n'))
}

// readHoldFiles — файлы держателей; битый файл пропускается.
func readHoldFiles(home string) []holdFile {
	es, _ := os.ReadDir(procsDir(home))
	var out []holdFile
	for _, e := range es {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(procsDir(home), e.Name()))
		if err != nil {
			continue
		}
		var f holdFile
		if json.Unmarshal(b, &f) == nil && validID(f.ID) {
			out = append(out, f)
		}
	}
	return out
}

// pump — вывод процесса хозяину или в память, ошибки — в журнал; затем выход процесса.
func (h *holder) pump(outR, errR *os.File) {
	outDone, errDone := make(chan struct{}), make(chan struct{})
	go func() {
		b := make([]byte, 32*1024)
		for {
			n, err := outR.Read(b)
			if n > 0 {
				h.deliver(b[:n])
			}
			if err != nil {
				break
			}
		}
		close(outDone)
	}()
	go func() {
		readLines(errR, func(s string) {
			h.j.note("stderr", "id", h.id, "line", s)
			if strings.TrimSpace(s) != "" {
				h.mu.Lock()
				h.lastErr = s
				h.mu.Unlock()
			}
		})
		close(errDone)
	}()
	h.cmd.Wait()
	// процесс вышел — его дети в задании тоже: иначе они держали бы трубы
	h.osh.killTree()
	<-outDone
	<-errDone
	outR.Close()
	errR.Close()
	h.osh.release()
	h.mu.Lock()
	code, sig := exitInfo(h.cmd.ProcessState, h.forced)
	h.exit = &exitInfoJSON{Code: code, Signal: sig, Stderr: h.lastErr, OSStop: h.osStop}
	c := h.conn
	h.mu.Unlock()
	h.j.note("held_exit", "id", h.id, "pid", h.cmd.Process.Pid, "code", code, "signal", sig, "stderr", h.lastErr)
	if c != nil {
		h.sendExit(c)
	}
}

// deliver — кусок вывода: хозяину, если подключён, иначе — в память.
func (h *holder) deliver(chunk []byte) {
	h.outMu.Lock()
	defer h.outMu.Unlock()
	h.mu.Lock()
	c := h.conn
	if c == nil {
		h.buf = append(h.buf, chunk...)
		h.mu.Unlock()
		return
	}
	h.mu.Unlock()
	if err := writeFrame(c, frOutput, chunk); err != nil {
		h.mu.Lock()
		if h.conn == c {
			h.conn = nil
		}
		h.buf = append(h.buf, chunk...)
		h.mu.Unlock()
		c.Close()
	}
}

// sendExit — выход отдан хозяину: держатель закрывает свою сторону (FIN после кадра выхода) и выходит, когда хозяин
// закрыл свою, — выход процесса с открытым соединением Windows обрывает сбросом, и непрочитанное хозяином пропадает.
func (h *holder) sendExit(c net.Conn) {
	h.outMu.Lock()
	err := writeJSONFrame(c, frExit, h.exit)
	h.outMu.Unlock()
	if err != nil {
		return // хозяин ушёл — отдадим следующему
	}
	h.mu.Lock()
	h.exitTo = c
	gone := h.conn != c // хозяин уже ушёл, его кадры дочитаны
	h.mu.Unlock()
	if tc, ok := c.(*net.TCPConn); ok {
		tc.CloseWrite()
	}
	if gone {
		c.Close()
		h.finish()
	}
}

func (h *holder) finish() {
	h.finishOnce.Do(func() {
		os.Remove(holdPath(h.home, h.id))
		close(h.done)
		h.ln.Close()
	})
}

// serve — принимать хозяина, пока процесс не вышел и выход не отдан.
func (h *holder) serve() int {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
	go func() {
		// остановка от ОС: закрыть ввод процессу и ждать его выхода; хозяин узнает из выхода, что это не падение
		<-sig
		h.j.note("hold_signal", "id", h.id)
		h.mu.Lock()
		h.osStop = true
		h.mu.Unlock()
		h.input(nil, true)
	}()
	go func() {
		for {
			c, err := h.ln.Accept()
			if err != nil {
				return
			}
			go h.accept(c)
		}
	}()
	<-h.done
	return 0
}

func (h *holder) accept(c net.Conn) {
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	t, b, err := readFrame(c)
	c.SetReadDeadline(time.Time{})
	if err != nil || t != frAuth || subtle.ConstantTimeCompare(b, []byte(h.key)) != 1 {
		writeFrame(c, frError, []byte("bad_key"))
		c.Close()
		return
	}
	h.outMu.Lock()
	h.mu.Lock()
	// новый хозяин вытесняет прежнего: прежний мог уйти, а держатель ещё не заметил обрыва (быстрый перезапуск keeper)
	if old := h.conn; old != nil {
		h.conn = nil
		old.Close()
		h.j.note("held_replaced", "id", h.id)
	}
	buf := h.buf
	h.buf, h.conn = nil, c
	exited := h.exit != nil
	h.mu.Unlock()
	err = writeJSONFrame(c, frHello, holderHello{Pid: h.cmd.Process.Pid, Buffered: len(buf)})
	for i := 0; err == nil && i < len(buf); i += 32 * 1024 {
		end := i + 32*1024
		if end > len(buf) {
			end = len(buf)
		}
		err = writeFrame(c, frOutput, buf[i:end])
	}
	h.outMu.Unlock()
	if err != nil {
		h.mu.Lock()
		if h.conn == c {
			h.conn = nil
		}
		h.buf = append(buf, h.buf...)
		h.mu.Unlock()
		c.Close()
		return
	}
	h.j.note("held_attach", "id", h.id, "buffered", len(buf))
	if exited {
		h.sendExit(c)
	}
	h.readOwner(c)
}

// readOwner — кадры хозяина: ввод и «закрой ввод» — в очередь ввода, «убей» — сразу.
// Ушёл хозяин — процесс живёт, вывод копится; ушёл хозяин, получивший выход, — держатель выходит.
func (h *holder) readOwner(c net.Conn) {
	br := bufio.NewReader(c)
	for {
		t, b, err := readFrame(br)
		if err != nil {
			break
		}
		switch t {
		case frInput:
			h.input(b, false)
		case frClose:
			h.input(nil, true)
		case frKill:
			h.mu.Lock()
			h.forced = true
			h.mu.Unlock()
			h.osh.killTree()
		}
	}
	h.mu.Lock()
	if h.conn == c {
		h.conn = nil
	}
	sent := h.exitTo == c
	h.mu.Unlock()
	c.Close()
	if sent {
		h.finish()
	}
}

/* ===== хозяин: запуск держателя и связь с ним ===== */

// holdSpec — что запустить под держателем.
type holdSpec struct {
	ID     string
	Owner  string
	Tag    string
	Cwd    string
	Env    []string
	Detach bool
	Cmd    []string
}

// spawnHolder — запустить держатель этим же файлом и дождаться строки о нём. Держатель не привязан к жизни хозяина.
func spawnHolder(home string, s holdSpec) (holdFile, error) {
	self, err := os.Executable()
	if err != nil {
		return holdFile{}, err
	}
	args := []string{"hold", "--id", s.ID, "--owner", s.Owner}
	if s.Cwd != "" {
		args = append(args, "--cwd", s.Cwd)
	}
	if s.Tag != "" {
		args = append(args, "--tag", s.Tag)
	}
	if s.Detach {
		args = append(args, "--detach-children")
	}
	args = append(args, "--")
	args = append(args, s.Cmd...)
	cmd := exec.Command(self, args...)
	cmd.Env = append(append([]string{}, s.Env...), "SWITCHBOARD_HOME="+home)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return holdFile{}, err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	setHolderAttr(cmd)
	if err := cmd.Start(); err != nil {
		return holdFile{}, err
	}
	line, rerr := bufio.NewReader(out).ReadString('\n')
	if rerr != nil && line == "" {
		cmd.Wait()
		return holdFile{}, fmt.Errorf("держатель не запустился: %s", strings.TrimSpace(stderr.String()))
	}
	// держатель живёт сам; его выход ждать некому — Release отпускает дескриптор
	cmd.Process.Release()
	var r struct {
		Port int    `json:"port"`
		Key  string `json:"key"`
		Pid  int    `json:"pid"`
	}
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		return holdFile{}, fmt.Errorf("строка держателя: %v", err)
	}
	return holdFile{ID: s.ID, Owner: s.Owner, Tag: s.Tag, Pid: r.Pid, Port: r.Port, Key: r.Key}, nil
}

// heldConn — соединение хозяина с держателем.
type heldConn struct {
	c   net.Conn
	wmu sync.Mutex
}

var errRefused = errors.New("держатель отказал")

// dialHolder — подключиться к держателю по файлу о нём; ответ — pid и накопленное.
func dialHolder(f holdFile) (*heldConn, holderHello, error) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port), 5*time.Second)
	if err != nil {
		return nil, holderHello{}, err
	}
	if err := writeFrame(c, frAuth, []byte(f.Key)); err != nil {
		c.Close()
		return nil, holderHello{}, err
	}
	t, b, err := readFrame(c)
	if err != nil {
		c.Close()
		return nil, holderHello{}, err
	}
	if t == frError {
		c.Close()
		return nil, holderHello{}, fmt.Errorf("%w: %s", errRefused, b)
	}
	var hh holderHello
	json.Unmarshal(b, &hh)
	return &heldConn{c: c}, hh, nil
}

func (hc *heldConn) send(t byte, data []byte) error {
	hc.wmu.Lock()
	defer hc.wmu.Unlock()
	return writeFrame(hc.c, t, data)
}

func (hc *heldConn) closeInput() error { return hc.send(frClose, nil) }
func (hc *heldConn) kill() error       { return hc.send(frKill, nil) }
func (hc *heldConn) Close()            { hc.c.Close() }

// read — кадры держателя: вывод в onOut; выход — ответом; обрыв — ошибкой.
func (hc *heldConn) read(onOut func([]byte)) (*exitInfoJSON, error) {
	br := bufio.NewReader(hc.c)
	for {
		t, b, err := readFrame(br)
		if err != nil {
			return nil, err
		}
		switch t {
		case frOutput:
			onOut(b)
		case frExit:
			var x exitInfoJSON
			json.Unmarshal(b, &x)
			return &x, nil
		}
	}
}

// readLines — построчно до конца; хвост без перевода строки — тоже строка.
func readLines(r io.Reader, f func(string)) {
	br := bufio.NewReader(r)
	for {
		s, err := br.ReadString('\n')
		if s != "" {
			f(strings.TrimRight(s, "\r\n"))
		}
		if err != nil {
			return
		}
	}
}
