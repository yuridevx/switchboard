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
	drainWait  = time.Second      // дочитать трубы после выхода: потомок вне задания держит их открытыми
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
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			s.cmd = args[i+1:]
			break
		}
		if a == "--detach-children" {
			s.detach = true
			continue
		}
		if i+1 >= len(args) {
			return s, false
		}
		switch a {
		case "--id":
			s.id = args[i+1]
		case "--owner":
			s.owner = args[i+1]
		case "--tag":
			s.tag = args[i+1]
		case "--cwd":
			s.cwd = args[i+1]
		default:
			return s, false
		}
		i++
	}
	return s, simpleName(s.id) && (s.owner == "keeper" || s.owner == "host") && len(s.cmd) > 0
}

type holder struct {
	spec   holdSpec
	home   string
	j      *journal
	proc   *os.Process
	tree   *tree
	mu     sync.Mutex
	cond   *sync.Cond
	out    []byte   // stdout, ещё не отданный хозяину
	owner  net.Conn // нынешний хозяин
	exit   *exitInfo
	sentTo net.Conn    // последний хозяин, которому отдан выход
	input  [][]byte    // ввод в очереди; nil — закрыть ввод
	gone   chan string // хозяин забрал выход и закрыл соединение
	// osStop — ввод закрыт по сигналу ОС; killed — дерево убито по кадру хозяина; cut — трубы больше не дочитываются
	osStop, killed, cut bool
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
	h := &holder{spec: spec, home: home, j: newJournal(home, os.Getenv("SWITCHBOARD_MACHINE")), gone: make(chan string, 1)}
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

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
	go h.signals(sig)
	go h.writeInput(inW)
	var pipes sync.WaitGroup
	pipes.Add(2)
	go func() { defer pipes.Done(); h.readOut(outR) }()
	lastErr := make(chan string, 1)
	go func() { defer pipes.Done(); lastErr <- h.readErr(errR) }()
	go h.accept(ln, hex.EncodeToString(key))

	state, _ := cmd.Process.Wait()
	h.tree.reap() // процесс вышел — его потомки тоже: иначе они держали бы трубы вывода
	drained := make(chan struct{})
	go func() { pipes.Wait(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(drainWait):
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
	x.OSStop = h.osStop
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
	return x
}

// signals — сигнал остановки ОС: ввод процесса закрыт, выход отдаётся с os_stop; убивает процесс по-прежнему ОС.
func (h *holder) signals(sig chan os.Signal) {
	for s := range sig {
		h.line("note", "hold_signal", "signal", s.String())
		h.mu.Lock()
		h.osStop = true
		h.mu.Unlock()
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
	hello, _ := json.Marshal(map[string]int{"pid": h.proc.Pid, "buffered": len(h.out)})
	h.cond.Broadcast()
	h.mu.Unlock()
	h.line("note", "held_attach")
	if writeFrame(c, 'h', hello) != nil {
		c.Close()
	}
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
			h.killed = true
			h.mu.Unlock()
			h.tree.kill()
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

// send — вывод и выход хозяину c, пока он хозяин.
func (h *holder) send(c net.Conn) {
	for {
		h.mu.Lock()
		for h.owner == c && len(h.out) == 0 && (h.exit == nil || h.sentTo == c) {
			h.cond.Wait()
		}
		if h.owner != c {
			h.mu.Unlock()
			return
		}
		out := h.out
		h.out = nil
		var x []byte
		if len(out) == 0 && h.exit != nil {
			x, _ = json.Marshal(h.exit)
			h.sentTo = c
		}
		h.cond.Broadcast()
		h.mu.Unlock()
		var err error
		if x != nil {
			err = writeFrame(c, 'x', x)
		} else {
			err = writeFrame(c, 'o', out)
		}
		if err != nil {
			return
		}
	}
}
