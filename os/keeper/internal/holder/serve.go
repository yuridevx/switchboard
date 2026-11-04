package holder

// Сторона держателя: keeper hold --id <id> --owner keeper|host [--cwd <папка>] [--tag <метка>] [--detach-children] -- <команда> <аргументы…>
//
// Запускает процесс с трубами ввода-вывода в своём задании ОС «закрыл — убей» (умер держатель — умер процесс), слушает 127.0.0.1 на порту от ОС,
// пишет о себе procs/<id>.json и одной строкой то же — в свой stdout, после чего stdout закрывает. Подключается только хозяин, по ключу.
// Весь вывод идёт одним путём: в буфер, из буфера — писателю соединения хозяина, за ним кадр выхода. Хозяина нет — буфер копится.
// Процесс вышел, выход отдан и хозяин закрыл соединение — файл убран, держатель вышел; хозяин не забрал выход за OwnerWait — тоже.
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
	"strings"
	"sync"
	"syscall"
	"time"

	"switchboard/keeper/internal/journal"
	"switchboard/keeper/internal/machine"
)

// OwnerWait — предел ожидания хозяина после выхода процесса: тот же, что у остановки части в keeper.
var OwnerWait = time.Minute

// authWait — предел кадра ключа от того, кто подключился.
const authWait = 10 * time.Second

// File — файл держателя в procs/.
type File struct {
	ID     string `json:"id"`
	Owner  string `json:"owner"`
	Pid    int    `json:"pid"`
	Holder int    `json:"holder"`
	Port   int    `json:"port"`
	Key    string `json:"key"`
	Tag    string `json:"tag,omitempty"`
}

// Path — файл держателя id.
func Path(home, id string) string { return filepath.Join(machine.ProcsDir(home), id+".json") }

// ReadFiles — файлы держателей; битый файл пропускается.
func ReadFiles(home string) []File {
	es, _ := os.ReadDir(machine.ProcsDir(home))
	var out []File
	for _, e := range es {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(machine.ProcsDir(home), e.Name()))
		if err != nil {
			continue
		}
		var f File
		if json.Unmarshal(b, &f) == nil && machine.ValidName(f.ID) {
			out = append(out, f)
		}
	}
	return out
}

// owner — соединение хозяина.
type owner struct {
	c       net.Conn
	gotExit bool // кадр выхода ему отдан
	gone    bool // его кадры дочитаны
}

type held struct {
	home, id string
	j        *journal.Journal
	key      string
	ln       net.Listener
	cmd      *exec.Cmd
	tree     *tree
	stdin    io.WriteCloser

	mu      sync.Mutex
	changed *sync.Cond // перемена в буфере, вводе, хозяине или выходе
	out     []byte     // вывод, ещё не отданный хозяину
	cur     *owner
	exit    *Exit
	taken   bool // кадр выхода отдан хоть кому-то
	forced  bool
	osStop  bool
	lastErr string
	in      [][]byte // ввод процесса: очередь и свой писатель — кадры хозяина читаются, даже когда процесс не читает ввод
	inEnd   bool     // «закрой ввод» — после очереди
	over    bool
	done    chan struct{}
}

// Main — вход режима держателя; код выхода.
func Main(args []string) int {
	fs := flag.NewFlagSet("hold", flag.ContinueOnError)
	id := fs.String("id", "", "имя части или позывной сессии")
	ownerName := fs.String("owner", "", "хозяин: keeper или host")
	cwd := fs.String("cwd", "", "рабочая папка процесса")
	detach := fs.Bool("detach-children", false, "дети процесса — не в задании держателя")
	tag := fs.String("tag", "", "метка хозяина: версия части")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	command := fs.Args()
	if !machine.ValidName(*id) || (*ownerName != "keeper" && *ownerName != "host") || len(command) == 0 {
		fmt.Fprintln(os.Stderr, "hold: нужны --id, --owner keeper|host и команда после --")
		return 2
	}
	home, err := machine.Home()
	if err != nil {
		fmt.Fprintln(os.Stderr, "hold:", err)
		return 1
	}
	j := journal.New(machine.JournalDir(home), machine.NameOf(machine.Key(home)), nil)
	if *ownerName == "keeper" {
		j = j.Holder(*id, "")
	} else {
		j = j.Holder("host", *id)
	}
	h, err := start(home, *id, *ownerName, *tag, *cwd, *detach, command, j)
	if err != nil {
		j.Stop("hold_failed", "держатель «"+*id+"» не запустил процесс: "+err.Error(), "id", *id)
		fmt.Fprintln(os.Stderr, "hold:", err)
		return 1
	}
	// одна строка о себе — тому, кто запустил; дальше stdout не нужен
	line, _ := json.Marshal(map[string]any{"port": h.ln.Addr().(*net.TCPAddr).Port, "key": h.key, "pid": h.cmd.Process.Pid})
	os.Stdout.Write(append(line, '\n'))
	os.Stdout.Close()
	h.serve()
	return 0
}

func start(home, id, ownerName, tag, cwd string, detach bool, command []string, j *journal.Journal) (*held, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = cwd
	stdin, err := cmd.StdinPipe()
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
	cmd.Stdout, cmd.Stderr = outW, errW
	SetProcAttr(cmd)
	err = cmd.Start()
	outW.Close()
	errW.Close()
	if err != nil {
		ln.Close()
		outR.Close()
		errR.Close()
		return nil, err
	}
	t, err := enclose(cmd.Process, detach)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		ln.Close()
		return nil, err
	}
	h := &held{home: home, id: id, j: j, key: hex.EncodeToString(raw), ln: ln, cmd: cmd, tree: t, stdin: stdin, done: make(chan struct{})}
	h.changed = sync.NewCond(&h.mu)
	f := File{ID: id, Owner: ownerName, Pid: cmd.Process.Pid, Holder: os.Getpid(), Port: ln.Addr().(*net.TCPAddr).Port, Key: h.key, Tag: tag}
	if err := writeFile(home, f); err != nil {
		t.kill()
		cmd.Wait()
		ln.Close()
		return nil, err
	}
	j.Note("hold", "id", id, "owner", ownerName, "pid", cmd.Process.Pid, "cmd", command)
	go h.watch(outR, errR)
	go h.writeInput()
	return h, nil
}

func writeFile(home string, f File) error {
	if err := os.MkdirAll(machine.ProcsDir(home), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(f, "", "  ")
	return machine.WriteAtomic(Path(home, f.ID), append(b, '\n'))
}

// writeInput — писатель трубы ввода: процесс не читает ввод — ждёт только он. Ошибка записи — процесс ушёл, остальное писать некуда.
func (h *held) writeInput() {
	for {
		h.mu.Lock()
		for len(h.in) == 0 && !h.inEnd && !h.over {
			h.changed.Wait()
		}
		q, end, over := h.in, h.inEnd, h.over
		h.in = nil
		h.mu.Unlock()
		for _, b := range q {
			h.stdin.Write(b)
		}
		if over {
			return
		}
		if end && len(q) == 0 {
			h.stdin.Close()
			return
		}
	}
}

// watch — вывод в буфер, ошибки в журнал, затем выход процесса.
func (h *held) watch(outR, errR *os.File) {
	var pipes sync.WaitGroup
	pipes.Add(2)
	go func() {
		defer pipes.Done()
		b := make([]byte, chunk)
		for {
			n, err := outR.Read(b)
			if n > 0 {
				h.mu.Lock()
				h.out = append(h.out, b[:n]...)
				h.changed.Broadcast()
				h.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		defer pipes.Done()
		br := bufio.NewReader(errR)
		for {
			s, err := br.ReadString('\n')
			if s != "" {
				s = strings.TrimRight(s, "\r\n")
				h.j.Note("stderr", "id", h.id, "line", s)
				if strings.TrimSpace(s) != "" {
					h.mu.Lock()
					h.lastErr = s
					h.mu.Unlock()
				}
			}
			if err != nil {
				return
			}
		}
	}()
	h.cmd.Wait()
	// процесс вышел — его дети в задании тоже: иначе они держали бы трубы
	h.tree.kill()
	pipes.Wait()
	outR.Close()
	errR.Close()
	h.tree.release()
	h.mu.Lock()
	code, sig := exitOf(h.cmd.ProcessState, h.forced)
	h.exit = &Exit{Code: code, Signal: sig, Stderr: h.lastErr, OSStop: h.osStop}
	h.changed.Broadcast()
	last := h.lastErr
	h.mu.Unlock()
	h.j.Note("held_exit", "id", h.id, "pid", h.cmd.Process.Pid, "code", code, "signal", sig, "stderr", last)
	time.AfterFunc(OwnerWait, h.unclaimed)
}

// unclaimed — процесс вышел OwnerWait назад: держатель выходит. Хозяин так и не забрал выход (keeper снят, Host не вернулся) — строка в журнал;
// вернувшийся хозяин держателя не найдёт — его ветка «процесса нет» (ubuntu-db 3 нояб.: держатель Host после снятия keeper ждал хозяина без предела).
func (h *held) unclaimed() {
	h.mu.Lock()
	taken := h.taken
	h.mu.Unlock()
	if !taken {
		h.j.Note("held_unclaimed", "id", h.id, "why", fmt.Sprintf("хозяин не забрал выход за %v — держатель вышел", OwnerWait))
	}
	h.finish()
}

func (h *held) finish() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.over {
		return
	}
	h.over = true
	os.Remove(Path(h.home, h.id))
	h.ln.Close()
	h.changed.Broadcast()
	close(h.done)
}

// serve — принимать хозяина, пока процесс не вышел и выход не отдан.
func (h *held) serve() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
	go func() {
		// остановка от ОС: закрыть ввод процессу и ждать его выхода; хозяин узнает из выхода, что это не падение. Таймер — у ОС
		<-sig
		h.j.Note("hold_signal", "id", h.id)
		h.mu.Lock()
		h.osStop, h.inEnd = true, true
		h.changed.Broadcast()
		h.mu.Unlock()
	}()
	go func() {
		for {
			c, err := h.ln.Accept()
			if err != nil {
				return
			}
			go h.welcome(c)
		}
	}()
	<-h.done
}

// welcome — кадр ключа; принятый хозяин вытесняет прежнего: прежний мог уйти, а держатель ещё не заметил обрыва (быстрый перезапуск keeper).
func (h *held) welcome(c net.Conn) {
	c.SetReadDeadline(time.Now().Add(authWait))
	t, b, err := readFrame(c)
	c.SetReadDeadline(time.Time{})
	if err != nil || t != frAuth || subtle.ConstantTimeCompare(b, []byte(h.key)) != 1 {
		writeFrame(c, frError, []byte("bad_key"))
		c.Close()
		return
	}
	o := &owner{c: c}
	h.mu.Lock()
	if old := h.cur; old != nil {
		old.c.Close()
		h.j.Note("held_replaced", "id", h.id)
	}
	h.cur = o
	buffered := len(h.out)
	h.changed.Broadcast()
	h.mu.Unlock()
	if writeJSON(c, frHello, Hello{Pid: h.cmd.Process.Pid, Buffered: buffered}) != nil {
		h.leave(o)
		return
	}
	h.j.Note("held_attach", "id", h.id, "buffered", buffered)
	go h.send(o)
	h.listen(o)
}

// send — писатель соединения: буфер кадрами, за ним выход; затем FIN — держатель выходит, когда хозяин закрыл свою сторону: выход процесса с открытым
// соединением Windows обрывает сбросом, и непрочитанное хозяином пропадает (2 нояб.: 2 из 50 прогонов).
func (h *held) send(o *owner) {
	for {
		h.mu.Lock()
		for h.cur == o && len(h.out) == 0 && h.exit == nil && !h.over {
			h.changed.Wait()
		}
		if h.cur != o || h.over {
			h.mu.Unlock()
			return
		}
		n := min(len(h.out), chunk)
		if n == 0 {
			x := h.exit
			h.mu.Unlock()
			h.sendExit(o, x)
			return
		}
		piece := append([]byte(nil), h.out[:n]...)
		h.out = h.out[n:]
		h.mu.Unlock()
		if err := writeFrame(o.c, frOutput, piece); err != nil {
			h.mu.Lock()
			h.out = append(piece, h.out...)
			h.mu.Unlock()
			o.c.Close()
			return
		}
	}
}

func (h *held) sendExit(o *owner, x *Exit) {
	if writeJSON(o.c, frExit, x) != nil {
		return // хозяин ушёл — отдадим следующему
	}
	if tc, ok := o.c.(*net.TCPConn); ok {
		tc.CloseWrite()
	}
	h.mu.Lock()
	o.gotExit, h.taken = true, true
	gone := o.gone
	h.mu.Unlock()
	if gone {
		h.finish()
	}
}

// listen — кадры хозяина: ввод и «закрой ввод» — в очередь, «убей» — сразу. Ушёл хозяин — процесс живёт, вывод копится; ушёл хозяин, получивший выход,
// — держатель выходит.
func (h *held) listen(o *owner) {
	br := bufio.NewReader(o.c)
	for {
		t, b, err := readFrame(br)
		if err != nil {
			break
		}
		switch t {
		case frInput:
			h.mu.Lock()
			h.in = append(h.in, b)
			h.changed.Broadcast()
			h.mu.Unlock()
		case frClose:
			h.mu.Lock()
			h.inEnd = true
			h.changed.Broadcast()
			h.mu.Unlock()
		case frKill:
			h.mu.Lock()
			h.forced = true
			h.mu.Unlock()
			h.tree.kill()
		}
	}
	h.leave(o)
}

func (h *held) leave(o *owner) {
	h.mu.Lock()
	o.gone = true
	if h.cur == o {
		h.cur = nil
		h.changed.Broadcast()
	}
	got := o.gotExit
	h.mu.Unlock()
	o.c.Close()
	if got {
		h.finish()
	}
}
