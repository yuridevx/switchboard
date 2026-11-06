package main

// Держатель: keeper hold --id <id> --owner keeper|host [--tag <версия>] [--cwd <папка>] [--detach-children] -- <команда>…
// Держит один процесс, его ввод и вывод и переживает своего хозяина. О себе пишет procs/<id>.json и одной строкой то же — в свой stdout.
// Протокол заморожен: TCP на 127.0.0.1, кадры [тип 1 байт][длина 4 байта, big-endian][данные].
//   хозяин → держатель: a ключ (первым, за 10 с), i ввод, c закрыть ввод (после всего ввода), k убить дерево процесса
//   держатель → хозяин: h {pid, buffered}, o вывод stdout, x {code, signal, stderr, os_stop?} после всего вывода, e слово отказа
// Новый хозяин вытесняет прежнего. Без хозяина вывод копится. Процесс вышел — дерево снято, выход ждёт хозяина не дольше ownerWait;
// хозяин забрал выход и закрыл соединение — файл убран, держатель вышел. Сигнал ОС — ввод процесса закрыт, выход с os_stop.
import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
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

// ownerWait — сколько держатель ждёт хозяина после выхода процесса.
var ownerWait = time.Minute

const (
	frameLimit = 4 << 20          // кадр хозяина и накопленный без хозяина вывод
	keyWait    = 10 * time.Second // кадр ключа после соединения
	drainWait  = 5 * time.Second  // дочитать трубы после выхода: потомок вне задания держит их открытыми
	chunk      = 32 << 10         // вывод хозяину — кусками: кадр не больше предела
	signalWait = time.Second      // процесс вышел по SIGTERM: столько ждать своего сигнала — ОС шлёт их всей группе без порядка
)

func writeFrame(w io.Writer, t byte, data []byte) error {
	b := make([]byte, 5+len(data))
	b[0] = t
	binary.BigEndian.PutUint32(b[1:5], uint32(len(data)))
	copy(b[5:], data)
	_, err := w.Write(b)
	return err
}

func readFrame(r io.Reader) (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[1:5])
	if n > frameLimit {
		return 0, nil, fmt.Errorf("кадр %d байт больше %d", n, frameLimit)
	}
	b := make([]byte, n)
	_, err := io.ReadFull(r, b)
	return h[0], b, err
}

// exitInfo — выход процесса, как его получает хозяин.
type exitInfo struct {
	Code   *int    `json:"code"`
	Signal *string `json:"signal"`
	Stderr string  `json:"stderr"`
	OSStop bool    `json:"os_stop,omitempty"`
}

type holdSpec struct {
	id, owner, tag, cwd string
	detach              bool
	cmd                 []string
}

func parseHold(args []string) (holdSpec, bool) {
	var s holdSpec
	fs := flag.NewFlagSet("hold", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&s.id, "id", "", "")
	fs.StringVar(&s.owner, "owner", "", "")
	fs.StringVar(&s.tag, "tag", "", "")
	fs.StringVar(&s.cwd, "cwd", "", "")
	fs.BoolVar(&s.detach, "detach-children", false, "")
	err := fs.Parse(args)
	s.cmd = fs.Args()
	return s, err == nil && simpleName(s.id) && (s.owner == "keeper" || s.owner == "host") && len(s.cmd) > 0
}

type holder struct {
	spec     holdSpec
	home     string
	j        *journal
	proc     *os.Process
	tree     *tree
	mu       sync.Mutex
	cond     *sync.Cond
	out      []byte   // stdout, ещё не отданный хозяину
	owner    net.Conn // нынешний хозяин
	exit     *exitInfo
	sentTo   net.Conn      // последний хозяин, которому отдан выход
	input    [][]byte      // ввод в очереди; nil — закрыть ввод
	gone     chan string   // хозяин забрал выход и закрыл соединение
	osSignal chan struct{} // закрыт: сигнал остановки ОС получен
	// killed — дерево убито по кадру хозяина; ended — процесс вышел; cut — трубы больше не дочитываются
	killed, ended, cut bool
}

func runHold(args []string) int {
	spec, ok := parseHold(args)
	if !ok {
		fmt.Fprintln(os.Stderr, "hold: нужны --id, --owner keeper|host и команда после --")
		return 2
	}
	home, err := homeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "hold: "+err.Error())
		return 1
	}
	h := &holder{spec: spec, home: home, j: newJournal(home, os.Getenv("SWITCHBOARD_MACHINE")), gone: make(chan string, 1), osSignal: make(chan struct{})}
	h.cond = sync.NewCond(&h.mu)
	if err := h.serve(); err != nil {
		h.line("stop", "hold_failed", "why", err.Error())
		fmt.Fprintln(os.Stderr, "hold: "+err.Error())
		return 1
	}
	return 0
}

// line — строка журнала под тем, чей процесс держатель держит: часть машины — её именем, сессия Host — host и callsign.
func (h *holder) line(kind, ev string, kv ...any) {
	if h.spec.owner == "host" {
		h.j.add("holder", "host", kind, ev, append(kv, "callsign", h.spec.id)...)
		return
	}
	h.j.add("holder", h.spec.id, kind, ev, append(kv, "id", h.spec.id)...)
}

func (h *holder) serve() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer ln.Close()
	key := make([]byte, 32)
	rand.Read(key)
	stdin, inW, err := os.Pipe()
	if err != nil {
		return err
	}
	outR, outW, _ := os.Pipe()
	errR, errW, _ := os.Pipe()
	cmd := exec.Command(h.spec.cmd[0], h.spec.cmd[1:]...)
	cmd.Dir, cmd.Stdin, cmd.Stdout, cmd.Stderr = h.spec.cwd, stdin, outW, errW
	h.tree = newTree(cmd, h.spec.detach)
	err = cmd.Start()
	stdin.Close()
	outW.Close()
	errW.Close()
	if err != nil {
		return err
	}
	h.proc = cmd.Process
	h.tree.adopt(cmd.Process)
	about := map[string]any{"id": h.spec.id, "owner": h.spec.owner, "pid": cmd.Process.Pid, "holder": os.Getpid(), "port": ln.Addr().(*net.TCPAddr).Port, "key": hex.EncodeToString(key)}
	if h.spec.tag != "" {
		about["tag"] = h.spec.tag
	}
	// сигнал слушается до строки о себе: кто её прочитал, может его прислать
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
	go h.signals(sig)
	file := filepath.Join(h.home, "procs", h.spec.id+".json")
	b, _ := json.Marshal(about)
	if err := writeFile(file, b); err != nil {
		h.tree.kill()
		return err
	}
	defer os.Remove(file)
	h.line("note", "hold", "pid", cmd.Process.Pid, "cmd", strings.Join(h.spec.cmd, " "))
	os.Stdout.Write(append(b, '\n'))
	os.Stdout.Close()

	go h.writeInput(inW)
	var pipes sync.WaitGroup
	pipes.Add(2)
	go func() { defer pipes.Done(); h.readOut(outR) }()
	lastErr := make(chan string, 1)
	go func() { defer pipes.Done(); lastErr <- h.readErr(errR) }()
	go h.accept(ln, hex.EncodeToString(key))

	state, _ := cmd.Process.Wait()
	h.mu.Lock()
	h.ended = true
	h.mu.Unlock()
	h.tree.reap() // процесс вышел — его потомки тоже: иначе они держали бы трубы вывода
	drained := make(chan struct{})
	go func() { pipes.Wait(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(drainWait):
		h.line("stop", "held_drain", "why", fmt.Sprintf("труба вывода открыта и через %v после выхода процесса", drainWait))
		h.mu.Lock()
		h.cut = true
		h.cond.Broadcast()
		h.mu.Unlock()
		outR.Close()
		errR.Close()
		<-drained
	}
	x := h.exitOf(state, <-lastErr)
	h.line("note", "held_exit", "code", x.Code, "signal", x.Signal)
	h.mu.Lock()
	h.exit = &x
	h.cond.Broadcast()
	h.mu.Unlock()
	select {
	case <-h.gone:
	case <-time.After(ownerWait):
		h.mu.Lock()
		sent := h.sentTo != nil
		h.mu.Unlock()
		if !sent {
			h.line("stop", "held_unclaimed", "why", fmt.Sprintf("хозяин не забрал выход за %v — держатель вышел", ownerWait))
		}
	}
	h.mu.Lock()
	if h.owner != nil {
		h.owner.Close()
	}
	h.mu.Unlock()
	return nil
}

func (h *holder) exitOf(state *os.ProcessState, stderr string) exitInfo {
	x := exitInfo{Stderr: stderr}
	h.mu.Lock()
	killed := h.killed
	h.mu.Unlock()
	sig := ""
	if state != nil {
		sig = signalOf(state)
	}
	if sig == "" && killed {
		sig = "SIGKILL"
	}
	if sig != "" {
		x.Signal = &sig
	} else if state != nil {
		c := state.ExitCode()
		x.Code = &c
	}
	if sig == "SIGTERM" {
		select {
		case <-h.osSignal:
		case <-time.After(signalWait):
		}
	}
	select {
	case <-h.osSignal:
		x.OSStop = true
	default:
	}
	return x
}

// signals — сигнал остановки ОС: ввод процесса закрыт, выход отдаётся с os_stop; убивает процесс по-прежнему ОС.
func (h *holder) signals(sig chan os.Signal) {
	var once sync.Once
	for s := range sig {
		once.Do(func() { close(h.osSignal) }) // первым делом: процесс мог получить тот же сигнал и уже выходит
		h.line("note", "hold_signal", "signal", s.String())
		h.queue(nil)
	}
}

// queue — ввод процессу по порядку; nil — закрыть ввод после всего, что в очереди.
func (h *holder) queue(b []byte) {
	h.mu.Lock()
	h.input = append(h.input, b)
	h.cond.Broadcast()
	h.mu.Unlock()
}

func (h *holder) writeInput(w *os.File) {
	defer w.Close()
	for {
		h.mu.Lock()
		for len(h.input) == 0 && h.exit == nil {
			h.cond.Wait()
		}
		if len(h.input) == 0 {
			h.mu.Unlock()
			return
		}
		b := h.input[0]
		h.input = h.input[1:]
		h.mu.Unlock()
		if b == nil {
			return
		}
		if _, err := w.Write(b); err != nil {
			return
		}
	}
}

// readOut — stdout: хозяину кадрами, вывод части машины — ещё и в журнал. Без хозяина копит до frameLimit, дальше процесс ждёт.
func (h *holder) readOut(r *os.File) {
	lines := lineSplitter(func(l string) {
		if h.spec.owner == "keeper" {
			h.line("note", "out", "line", l)
		}
	})
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			lines(buf[:n])
			h.mu.Lock()
			for len(h.out) >= frameLimit && !h.cut {
				h.cond.Wait()
			}
			h.out = append(h.out, buf[:n]...)
			h.cond.Broadcast()
			h.mu.Unlock()
		}
		if err != nil {
			lines(nil)
			return
		}
	}
}

// readErr — stderr: в журнал по строке; последняя строка — в кадр выхода.
func (h *holder) readErr(r *os.File) string {
	last := ""
	lines := lineSplitter(func(l string) {
		h.line("note", "out", "line", l, "stream", "stderr")
		last = l
	})
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		lines(buf[:n])
		if err != nil {
			lines(nil)
			return last
		}
	}
}

// lineSplitter — строки из кусков вывода; nil — конец: хвост без перевода строки тоже строка.
func lineSplitter(on func(string)) func([]byte) {
	var rest []byte
	return func(b []byte) {
		if b == nil {
			if len(rest) > 0 {
				on(strings.TrimRight(string(rest), "\r"))
				rest = nil
			}
			return
		}
		rest = append(rest, b...)
		for {
			i := bytes.IndexByte(rest, '\n')
			if i < 0 {
				return
			}
			if l := strings.TrimRight(string(rest[:i]), "\r"); l != "" {
				on(l)
			}
			rest = rest[i+1:]
		}
	}
}

func (h *holder) accept(ln net.Listener, key string) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go h.attach(c, key)
	}
}

// attach — хозяин: ключ первым кадром, затем hello, накопленное, живой вывод и выход; его кадры — ввод, закрыть ввод, убить.
func (h *holder) attach(c net.Conn, key string) {
	c.SetReadDeadline(time.Now().Add(keyWait))
	t, b, err := readFrame(c)
	if err != nil || t != 'a' || string(b) != key {
		writeFrame(c, 'e', []byte("bad_key"))
		c.Close()
		return
	}
	c.SetReadDeadline(time.Time{})
	h.mu.Lock()
	if h.owner != nil {
		h.owner.Close()
		h.line("note", "held_replaced")
	}
	h.owner = c
	h.cond.Broadcast()
	h.mu.Unlock()
	h.line("note", "held_attach")
	go h.send(c)
	for {
		t, b, err := readFrame(c)
		if err != nil {
			break
		}
		switch t {
		case 'i':
			h.queue(b)
		case 'c':
			h.queue(nil)
		case 'k':
			h.mu.Lock()
			if !h.ended { // вышедший процесс не убивать: номер его группы мог занять другой
				h.killed = true
				h.tree.kill()
			}
			h.mu.Unlock()
		}
	}
	c.Close()
	h.mu.Lock()
	mine, sent := h.owner == c, h.sentTo == c
	if mine {
		h.owner = nil
		h.cond.Broadcast()
	}
	h.mu.Unlock()
	if mine && sent {
		select {
		case h.gone <- "хозяин забрал выход":
		default:
		}
	}
}

// send — писатель соединения: приветствие с первым куском вывода — одной записью (вытесненный хозяин всё равно их получит), вывод кусками, за ним
// выход. Кусок, который не ушёл, возвращается в буфер — следующему хозяину.
func (h *holder) send(c net.Conn) {
	greet := true
	for {
		h.mu.Lock()
		for !greet && h.owner == c && len(h.out) == 0 && (h.exit == nil || h.sentTo == c) {
			h.cond.Wait()
		}
		if h.owner != c {
			h.mu.Unlock()
			return
		}
		var b bytes.Buffer
		if greet {
			hello, _ := json.Marshal(map[string]int{"pid": h.proc.Pid, "buffered": len(h.out)})
			writeFrame(&b, 'h', hello)
		}
		n := min(len(h.out), chunk)
		out := append([]byte(nil), h.out[:n]...)
		h.out = h.out[n:]
		if n > 0 {
			writeFrame(&b, 'o', out)
		} else if !greet {
			x, _ := json.Marshal(h.exit)
			writeFrame(&b, 'x', x)
			h.sentTo = c
		}
		greet = false
		h.cond.Broadcast()
		h.mu.Unlock()
		if _, err := c.Write(b.Bytes()); err != nil {
			h.mu.Lock()
			h.out = append(out, h.out...)
			if h.sentTo == c {
				h.sentTo = nil
			}
			h.cond.Broadcast()
			h.mu.Unlock()
			return
		}
	}
}
