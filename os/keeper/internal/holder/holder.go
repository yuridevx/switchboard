package holder

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
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
	"slices"
	"sync"
	"syscall"
	"time"

	"switchboard/keeper/internal/machine"
)

// OwnerWait — сколько держатель ждёт хозяина после выхода процесса.
var OwnerWait = time.Minute

const (
	authWait  = 10 * time.Second // кадр ключа от того, кто подключился
	drainWait = 5 * time.Second  // потомок вне задания держит трубу вывода после выхода процесса
	chunk     = 32 * 1024        // кусок вывода в одном кадре
)

// server — держатель: один процесс, один хозяин. Весь вывод идёт одним путём: в буфер, из буфера — хозяину, за ним кадр выхода. Хозяина нет — буфер копится.
type server struct {
	j    *machine.Journal
	part string // чей процесс: часть машины — её имя, сессия — host
	who  []any  // поля «о ком» в строках журнала
	key  string
	pid  int
	tree *tree
	done chan struct{}
	once sync.Once

	mu         sync.Mutex
	cond       *sync.Cond
	out        []byte // вывод, ещё не отданный хозяину
	owner      net.Conn
	input      [][]byte // ввод процесса: кадры хозяина читаются, даже когда процесс не читает ввод
	inputEnd   bool     // «закрой ввод» — после очереди
	lastStderr string
	exit       []byte // кадр выхода: процесс вышел, вывод дочитан
	taken      bool   // кадр выхода отдан хоть кому-то
	killed     bool
	osStop     bool
}

func (s *server) line(kind, ev string, kv ...any) {
	s.j.Line(s.part, kind, ev, slices.Concat(s.who, kv)...)
}

type options struct {
	id, owner, tag, cwd string
	detach              bool
	cmd                 []string
}

func parseArgs(args []string) (options, error) {
	var o options
	fs := flag.NewFlagSet("hold", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&o.id, "id", "", "")
	fs.StringVar(&o.owner, "owner", "", "")
	fs.StringVar(&o.tag, "tag", "", "")
	fs.StringVar(&o.cwd, "cwd", "", "")
	fs.BoolVar(&o.detach, "detach-children", false, "")
	err := fs.Parse(args)
	o.cmd = fs.Args()
	if err == nil && (!machine.ValidName(o.id) || (o.owner != "keeper" && o.owner != "host") || len(o.cmd) == 0) {
		err = flag.ErrHelp
	}
	return o, err
}

// Main — команда hold; код выхода. Папка — из SWITCHBOARD_HOME, имени флота держатель не разбирает.
func Main(args []string) int {
	o, err := parseArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hold: нужны --id, --owner keeper|host и команда после --")
		return 2
	}
	home, err := machine.Home()
	if err != nil {
		fmt.Fprintln(os.Stderr, "hold:", err)
		return 1
	}
	s := &server{j: machine.NewJournal(home, "holder", nil), part: o.id, who: []any{"id", o.id}, done: make(chan struct{})}
	s.cond = sync.NewCond(&s.mu)
	if o.owner == "host" {
		s.part, s.who = "host", []any{"callsign", o.id, "id", o.id}
	}
	if err := s.start(home, o); err != nil {
		s.line("stop", "hold_failed", "why", "держатель «"+o.id+"» не запустил процесс: "+err.Error())
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	<-s.done
	Remove(home, o.id)
	return 0
}

// start — порт, процесс в своём дереве, файл о себе, строка о себе в stdout, после чего stdout закрыт.
func (s *server) start(home string, o options) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	cmd := exec.Command(o.cmd[0], o.cmd[1:]...)
	cmd.Dir = o.cwd
	Prepare(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	// трубы вывода — свои: Wait узнаёт о выходе процесса, не дожидаясь их конца
	outR, outW, err := os.Pipe()
	if err != nil {
		return err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdout, cmd.Stderr = outW, errW
	err = cmd.Start()
	outW.Close()
	errW.Close()
	if err != nil {
		return err
	}
	if s.tree, err = newTree(cmd, o.detach); err != nil {
		cmd.Process.Kill()
		return err
	}
	secret := make([]byte, 32)
	rand.Read(secret)
	s.key = hex.EncodeToString(secret)
	s.pid = cmd.Process.Pid
	f := File{ID: o.id, Owner: o.owner, Pid: s.pid, Holder: os.Getpid(), Port: ln.Addr().(*net.TCPAddr).Port, Key: s.key, Tag: o.tag}
	b, _ := json.Marshal(f)
	err = os.MkdirAll(filepath.Dir(filePath(home, o.id)), 0o700)
	if err == nil {
		err = machine.WriteAtomic(filePath(home, o.id), b)
	}
	if err != nil {
		s.tree.kill()
		return err
	}
	s.line("note", "hold", "owner", o.owner, "pid", s.pid, "cmd", o.cmd)

	// сигнал слушается до строки о себе: кто её прочитал, может его прислать
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, os.Interrupt)
	go s.onSignal(stop)
	about, _ := json.Marshal(map[string]any{"port": f.Port, "key": s.key, "pid": s.pid})
	os.Stdout.Write(append(about, '\n'))
	os.Stdout.Close()

	var read sync.WaitGroup
	read.Add(2)
	go func() { defer read.Done(); s.readOut(outR) }()
	go func() { defer read.Done(); s.readErr(errR) }()
	go s.writeInput(stdin)
	go s.accept(ln)
	go s.waitExit(cmd, &read)
	return nil
}

// onSignal — остановка от ОС: закрыть ввод и ждать выхода, хозяин узнает из кадра выхода, что это не падение. Таймер — у ОС.
func (s *server) onSignal(stop <-chan os.Signal) {
	<-stop
	s.line("note", "hold_signal")
	s.mu.Lock()
	s.osStop, s.inputEnd = true, true
	s.cond.Broadcast()
	s.mu.Unlock()
}

func (s *server) readOut(r io.Reader) {
	buf := make([]byte, chunk)
	for {
		n, err := r.Read(buf)
		s.mu.Lock()
		s.out = append(s.out, buf[:n]...)
		s.cond.Broadcast()
		s.mu.Unlock()
		if err != nil {
			return
		}
	}
}

func (s *server) readErr(r io.Reader) {
	lines := machine.Lines{Emit: func(l string) {
		s.line("note", "stderr", "line", l)
		if l != "" {
			s.mu.Lock()
			s.lastStderr = l
			s.mu.Unlock()
		}
	}}
	io.Copy(&lines, r)
	lines.Flush()
}

// writeInput — ввод своей горутиной: процесс не читает ввод — ждёт только она, «убей» доходит сразу. Ошибка записи — процесс ушёл.
func (s *server) writeInput(w io.WriteCloser) {
	defer w.Close()
	for {
		s.mu.Lock()
		for len(s.input) == 0 && !s.inputEnd {
			s.cond.Wait()
		}
		if len(s.input) == 0 {
			s.mu.Unlock()
			return
		}
		b := s.input[0]
		s.input = s.input[1:]
		s.mu.Unlock()
		if _, err := w.Write(b); err != nil {
			return
		}
	}
}

// waitExit — процесс вышел: его потомки тоже (иначе держат трубы), вывод дочитан; кадр выхода ждёт хозяина не дольше OwnerWait.
func (s *server) waitExit(cmd *exec.Cmd, read *sync.WaitGroup) {
	cmd.Wait()
	s.tree.kill()
	drained := make(chan struct{})
	go func() { read.Wait(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(drainWait):
		s.line("stop", "held_drain", "why", fmt.Sprintf("труба вывода открыта и через %v после выхода", drainWait))
	}
	x := Exit{}
	s.mu.Lock()
	code, sig := exitOf(cmd.ProcessState)
	if s.killed {
		sig = "SIGKILL"
	}
	if sig != "" {
		x.Signal = &sig
	} else {
		x.Code = &code
	}
	x.Stderr, x.OSStop = s.lastStderr, s.osStop
	b, _ := json.Marshal(x)
	s.exit = frame(kExit, b)
	s.cond.Broadcast()
	s.mu.Unlock()
	s.line("note", "held_exit", "pid", s.pid, "code", x.Code, "signal", x.Signal, "stderr", x.Stderr)

	time.Sleep(OwnerWait)
	s.mu.Lock()
	taken := s.taken
	s.mu.Unlock()
	if !taken {
		s.line("note", "held_unclaimed", "why", fmt.Sprintf("хозяин не забрал выход за %v — держатель вышел", OwnerWait))
	}
	s.finish()
}

func (s *server) finish() { s.once.Do(func() { close(s.done) }) }

func (s *server) accept(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go s.serve(c)
	}
}

// serve — кадр ключа, затем команды хозяина. Принятый хозяин вытесняет прежнего: прежний мог уйти, а держатель ещё не заметил обрыва.
func (s *server) serve(c net.Conn) {
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(authWait))
	r := bufio.NewReader(c)
	t, key, err := readFrame(r)
	if err != nil || t != kAuth || subtle.ConstantTimeCompare(key, []byte(s.key)) != 1 {
		c.Write(frame(kError, []byte("bad_key")))
		return
	}
	c.SetReadDeadline(time.Time{})

	s.mu.Lock()
	old := s.owner
	s.owner = c
	buffered := len(s.out)
	s.cond.Broadcast()
	s.mu.Unlock()
	if old != nil {
		old.Close()
		s.line("note", "held_replaced")
	}
	s.line("note", "held_attach", "buffered", buffered)
	hello, _ := json.Marshal(Hello{Pid: s.pid, Buffered: buffered})
	go s.pump(c, frame(kHello, hello))

	for {
		t, b, err := readFrame(r)
		if err != nil {
			break
		}
		s.mu.Lock()
		switch t {
		case kInput:
			s.input = append(s.input, b)
		case kClose:
			s.inputEnd = true
		case kKill:
			// вышедший процесс не убивать: номер его группы мог занять другой
			if s.exit == nil {
				s.killed = true
				s.tree.kill()
			}
		}
		s.cond.Broadcast()
		s.mu.Unlock()
	}
	s.mu.Lock()
	current := s.owner == c
	if current {
		s.owner = nil
		s.cond.Broadcast()
	}
	taken := s.taken
	s.mu.Unlock()
	// хозяин забрал выход и закрыл соединение. Раньше своей стороны не закрывать: выход процесса с открытым соединением Windows обрывает сбросом,
	// и непрочитанное хозяином пропадает (2 нояб.: 2 из 50 прогонов)
	if current && taken {
		s.finish()
	}
}

// pump — писатель соединения: вывод кадрами, за ним выход. Приветствие и первый кусок — одним write: вытесненный хозяин всё равно их получит.
// Кусок, который не ушёл, возвращается в буфер — следующему хозяину.
func (s *server) pump(c net.Conn, head []byte) {
	sentExit := false
	for {
		s.mu.Lock()
		for s.owner == c && len(s.out) == 0 && head == nil && (s.exit == nil || sentExit) {
			s.cond.Wait()
		}
		if s.owner != c {
			s.mu.Unlock()
			return
		}
		b := head
		head = nil
		piece := s.out[:min(len(s.out), chunk)]
		s.out = s.out[len(piece):]
		if len(piece) > 0 {
			b = append(b, frame(kOut, piece)...)
		}
		last := len(s.out) == 0 && s.exit != nil && !sentExit
		if last {
			b = append(b, s.exit...)
		}
		s.mu.Unlock()
		_, err := c.Write(b)
		s.mu.Lock()
		if err != nil {
			s.out = slices.Concat(piece, s.out)
			s.mu.Unlock()
			return
		}
		if last {
			sentExit, s.taken = true, true
		}
		s.mu.Unlock()
	}
}
