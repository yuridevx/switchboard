package main

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

//go:embed module.json
var manifest []byte

// keeperVersion — версия из module.json: один источник.
var keeperVersion = func() string {
	var m struct{ Version string }
	json.Unmarshal(manifest, &m)
	return m.Version
}()

// proto — версия протокола keeper в первой строке соединения. Другой нет.
const proto = 1

// Keeper — служба без логики: держит процессы claude, запускает и обновляет Host.
type Keeper struct {
	home string
	j    *Journal
	key  string
	ln   net.Listener

	mu        sync.Mutex
	procs     map[string]*proc
	control   *control
	queued    [][]byte // exited, пока Host нет на связи
	host      *hostRun // работающий Host или nil
	version   string   // версия Host, которую запускать
	ready     bool     // текущий Host прислал ready
	early     int      // выходы Host до ready подряд
	upgradeTo string   // версия после штатного выхода по upgrade
	stopping  bool
	stopOnCtl bool // stop machine — как только Host откроет управление

	procWG   sync.WaitGroup
	stopOnce sync.Once
	done     chan struct{}
}

// hostRun — один запуск Host.
type hostRun struct {
	version string
	cmd     *exec.Cmd
	osh     *osHandle
	lastErr string
	exited  chan struct{}
}

// control — соединение управления; запись — под своим замком.
type control struct {
	c   net.Conn
	wmu sync.Mutex
}

func (ctl *control) send(b []byte) {
	ctl.wmu.Lock()
	ctl.c.Write(b)
	ctl.wmu.Unlock()
}

// first — первая строка соединения: ключ, версия протокола, действие и поля spawn/attach.
type first struct {
	Key     string            `json:"key"`
	Proto   int               `json:"proto"`
	Op      string            `json:"op"`
	ID      string            `json:"id"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Cwd     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
}

type reply struct {
	Op     string `json:"op"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func line(v any) []byte {
	b, _ := json.Marshal(v)
	return append(b, '\n')
}

func okLine(result any) []byte { return line(reply{Op: "reply", OK: true, Result: result}) }
func failLine(word string) []byte {
	return line(reply{Op: "reply", OK: false, Error: word})
}

// Start — слушать 127.0.0.1 на порту от ОС, новый ключ, запуск Host из keeper.json.
func Start(home string, echo io.Writer) (*Keeper, error) {
	conf, confErr := readConf(home)
	machine := confStr(conf, "machine")
	if machine == "" {
		hn, _ := os.Hostname()
		machine = strings.ToLower(hn)
	}
	j := newJournal(filepath.Join(home, "journal"), machine, echo)
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		j.stop("keeper_start", "порт не открыт: "+err.Error())
		return nil, err
	}
	k := &Keeper{
		home:  home,
		j:     j,
		key:   hex.EncodeToString(raw),
		ln:    ln,
		procs: map[string]*proc{},
		done:  make(chan struct{}),
	}
	j.note("keeper_start", "keeper", keeperVersion, "port", ln.Addr().(*net.TCPAddr).Port, "pid", os.Getpid())
	if confErr != nil {
		j.stop("host_failed", "keeper.json не прочитан: "+confErr.Error()+" — Host не запускаю")
	}
	go k.acceptLoop()
	k.mu.Lock()
	if confErr == nil {
		k.version = confStr(conf, "host")
		k.launch()
	}
	k.mu.Unlock()
	return k, nil
}

// Addr — адрес порта keeper.
func (k *Keeper) Addr() string { return k.ln.Addr().String() }

// Done — закрыт, когда keeper остановился.
func (k *Keeper) Done() <-chan struct{} { return k.done }

// Stop — штатная остановка: stop machine Host и ждать его выхода (без своего таймера),
// затем завершить оставшиеся процессы целиком и выйти.
func (k *Keeper) Stop() {
	k.stopOnce.Do(func() { go k.shutdown() })
	<-k.done
}

func (k *Keeper) shutdown() {
	k.mu.Lock()
	k.stopping = true
	run, ctl := k.host, k.control
	if run != nil && ctl == nil {
		k.stopOnCtl = true
	}
	k.mu.Unlock()
	k.j.note("keeper_stop")
	if run != nil {
		if ctl != nil {
			ctl.send(line(map[string]string{"op": "stop", "reason": "machine"}))
		}
		<-run.exited
	}
	k.ln.Close()
	k.mu.Lock()
	left := []string{}
	for _, p := range k.procs {
		left = append(left, p.id)
		p.kill(true)
	}
	if k.control != nil {
		k.control.c.Close()
		k.control = nil
	}
	k.mu.Unlock()
	if len(left) > 0 {
		sort.Strings(left)
		k.j.note("kill_left", "ids", left)
	}
	k.procWG.Wait()
	k.j.note("keeper_exit")
	close(k.done)
}

func (k *Keeper) acceptLoop() {
	for {
		c, err := k.ln.Accept()
		if err != nil {
			k.mu.Lock()
			stopping := k.stopping
			k.mu.Unlock()
			if !stopping {
				k.j.stop("accept", "порт keeper закрыт: "+err.Error())
				k.stopOnce.Do(func() { go k.shutdown() })
			}
			return
		}
		go k.serve(c)
	}
}

/* ===== запуск Host ===== */

// launch — запустить Host версии k.version; k.mu взят.
func (k *Keeper) launch() {
	for {
		v := k.version
		if v == "" {
			k.j.stop("host_failed", "в keeper.json нет версии Host — не запускаю")
			return
		}
		if !versionExists(k.home, v) {
			k.j.stop("host_failed", "папки Host "+v+" нет — не запускаю", "host", v)
			return
		}
		err := k.startHost(v)
		if err == nil {
			return
		}
		// не запустился — как выход до ready
		if !k.exitBeforeReady(v, "Host "+v+" не запустился: "+err.Error(), nil) {
			return
		}
	}
}

func (k *Keeper) startHost(v string) error {
	conf, err := readConf(k.home)
	if err != nil {
		return err
	}
	node := confStr(conf, "node")
	if node == "" {
		return fmt.Errorf("в keeper.json нет node")
	}
	dir := hostDir(k.home, v)
	cmd := exec.Command(node, filepath.Join(dir, "host"))
	cmd.Dir = dir
	inR, inW, err := os.Pipe()
	if err != nil {
		return err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		return err
	}
	cmd.Stdin, cmd.Stderr = inR, errW
	setProcAttr(cmd)
	err = cmd.Start()
	inR.Close()
	errW.Close()
	if err != nil {
		inW.Close()
		errR.Close()
		return err
	}
	osh, err := afterStart(cmd.Process)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		inW.Close()
		errR.Close()
		return err
	}
	// порт и ключ — одной строкой во ввод Host, затем ввод закрыт
	inW.Write(line(map[string]string{"keeper": k.Addr(), "key": k.key}))
	inW.Close()
	run := &hostRun{version: v, cmd: cmd, osh: osh, exited: make(chan struct{})}
	k.host = run
	k.j.note("host_start", "host", v, "pid", cmd.Process.Pid)
	go k.watchHost(run, errR)
	return nil
}

func (k *Keeper) watchHost(run *hostRun, errR *os.File) {
	errDone := make(chan struct{})
	go func() {
		readLines(errR, func(s string) {
			k.j.note("host_stderr", "host", run.version, "line", s)
			if strings.TrimSpace(s) != "" {
				run.lastErr = s
			}
		})
		close(errDone)
	}()
	run.cmd.Wait()
	run.osh.killTree() // потомки Host умирают с ним
	<-errDone
	errR.Close()
	run.osh.release()
	k.hostExited(run)
}

func (k *Keeper) hostExited(run *hostRun) {
	code := run.cmd.ProcessState.ExitCode()
	k.mu.Lock()
	defer close(run.exited)
	defer k.mu.Unlock()
	k.host = nil
	// соединение управления принадлежало вышедшему Host
	if k.control != nil {
		k.control.c.Close()
		k.control = nil
	}
	why := fmt.Sprintf("Host %s вышел с кодом %d", run.version, code)
	if run.lastErr != "" {
		why += ": " + run.lastErr
	}
	switch {
	case k.stopping:
		k.j.note("host_exit", "host", run.version, "code", code)
	case k.upgradeTo != "":
		k.j.note("host_exit", "host", run.version, "code", code, "upgrade", k.upgradeTo)
		k.version, k.upgradeTo = k.upgradeTo, ""
		k.ready, k.early = false, 0
		k.launch()
	case k.ready:
		k.j.stop("host_exit", why, "host", run.version, "code", code, "stderr", run.lastErr)
		k.ready, k.early = false, 0
		k.launch()
	default:
		if k.exitBeforeReady(run.version, why+" до ready", &code) {
			k.launch()
		}
	}
}

// exitBeforeReady — выход Host до ready; true — запустить снова. Второй подряд — стоп.
func (k *Keeper) exitBeforeReady(v, why string, code *int) bool {
	k.early++
	kv := []any{"host", v}
	if code != nil {
		kv = append(kv, "code", *code)
	}
	k.j.stop("host_exit", why, kv...)
	if k.early < 2 {
		return true
	}
	ids := make([]string, 0, len(k.procs))
	for id := range k.procs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	alive := "процессов claude нет"
	if len(ids) > 0 {
		alive = "процессы claude живы: " + strings.Join(ids, ", ")
	}
	k.j.stop("host_failed", "host "+v+": два выхода до ready — не запускаю; "+alive, "host", v)
	return false
}

/* ===== соединения ===== */

func (k *Keeper) serve(c net.Conn) {
	br := bufio.NewReader(c)
	b, err := br.ReadBytes('\n')
	if err != nil && len(b) == 0 {
		c.Close()
		return
	}
	var h first
	if json.Unmarshal(b, &h) != nil {
		k.refuse(c, "first_line", "bad_key", "первая строка — не JSON")
		return
	}
	if h.Key == "" {
		k.refuse(c, "first_line", "bad_key", "нет ключа · op "+h.Op)
		return
	}
	if subtle.ConstantTimeCompare([]byte(h.Key), []byte(k.key)) != 1 {
		k.refuse(c, "first_line", "bad_key", "ключ не совпал · op "+h.Op)
		return
	}
	if h.Proto != proto {
		k.refuse(c, "first_line", "contract_mismatch",
			fmt.Sprintf("proto %d — keeper знает %d", h.Proto, proto), "proto", h.Proto, "keeper_proto", proto)
		return
	}
	switch h.Op {
	case "control":
		k.serveControl(c, br)
	case "spawn":
		k.serveSpawn(c, br, h)
	case "attach":
		k.serveAttach(c, br, h.ID)
	default:
		k.refuse(c, "first_line", "unknown_op", "первая строка: op «"+h.Op+"»")
	}
}

// refuse — ответ со словом, строка в журнале, соединение закрыто.
func (k *Keeper) refuse(c net.Conn, ev, word, why string, kv ...any) {
	c.Write(failLine(word))
	k.j.refuse(ev, word, why, kv...)
	c.Close()
}

func (k *Keeper) serveControl(c net.Conn, br *bufio.Reader) {
	ctl := &control{c: c}
	ctl.wmu.Lock()
	k.mu.Lock()
	if k.control != nil {
		k.mu.Unlock()
		ctl.wmu.Unlock()
		k.refuse(c, "control", "in_use", "второе соединение управления")
		return
	}
	k.control = ctl
	q := k.queued
	k.queued = nil
	stopNow := k.stopOnCtl
	k.stopOnCtl = false
	k.mu.Unlock()
	// ответ, затем exited вышедших без Host, затем stop, если остановка уже идёт
	c.Write(okLine(map[string]string{"keeper": keeperVersion}))
	for _, ev := range q {
		c.Write(ev)
	}
	if stopNow {
		c.Write(line(map[string]string{"op": "stop", "reason": "machine"}))
	}
	ctl.wmu.Unlock()
	k.j.note("control", "queued", len(q))

	for {
		b, err := br.ReadBytes('\n')
		if len(strings.TrimSpace(string(b))) > 0 {
			k.request(ctl, b)
		}
		if err != nil {
			break
		}
	}
	k.mu.Lock()
	mine := k.control == ctl
	if mine {
		k.control = nil
	}
	k.mu.Unlock()
	c.Close()
	if mine {
		k.j.note("control_closed")
	}
}

// request — запрос по соединению управления; ответы — по порядку запросов.
func (k *Keeper) request(ctl *control, b []byte) {
	var r struct {
		Op      string `json:"op"`
		ID      string `json:"id"`
		Force   bool   `json:"force"`
		Version string `json:"version"`
	}
	if json.Unmarshal(b, &r) != nil {
		ctl.send(failLine("bad_frame"))
		k.j.refuse("request", "bad_frame", "строка управления — не JSON")
		return
	}
	switch r.Op {
	case "list":
		ctl.send(okLine(map[string]any{"processes": k.list()}))
	case "kill":
		k.mu.Lock()
		p := k.procs[r.ID]
		k.mu.Unlock()
		if p == nil || p.gone() {
			ctl.send(failLine("unknown_id"))
			k.j.refuse("kill", "unknown_id", "kill: процесса «"+r.ID+"» нет", "id", r.ID)
			return
		}
		p.kill(r.Force)
		k.j.note("kill", "id", r.ID, "force", r.Force)
		ctl.send(okLine(nil))
	case "upgrade":
		if !versionExists(k.home, r.Version) {
			ctl.send(failLine("unknown_version"))
			k.j.refuse("upgrade", "unknown_version", "upgrade: папки Host «"+r.Version+"» нет — Host не тронут", "host", r.Version)
			return
		}
		k.mu.Lock()
		from := k.version
		if k.host != nil {
			from = k.host.version
		}
		k.upgradeTo = r.Version
		k.mu.Unlock()
		k.j.note("upgrade", "why", "Host "+from+" → "+r.Version, "from", from, "to", r.Version)
		ctl.send(okLine(nil))
		ctl.send(line(map[string]string{"op": "stop", "reason": "upgrade"}))
	case "ready":
		if !versionExists(k.home, r.Version) {
			ctl.send(failLine("unknown_version"))
			k.j.refuse("ready", "unknown_version", "ready: папки Host «"+r.Version+"» нет — keeper.json прежний", "host", r.Version)
			return
		}
		if err := setConf(k.home, "host", r.Version); err != nil {
			ctl.send(failLine("write_failed"))
			k.j.stop("ready", "keeper.json не записан: "+err.Error(), "host", r.Version)
			return
		}
		k.mu.Lock()
		k.version, k.ready, k.early = r.Version, true, 0
		k.mu.Unlock()
		k.j.note("host_ready", "host", r.Version)
		ctl.send(okLine(nil))
	default:
		ctl.send(failLine("unknown_op"))
		k.j.refuse("request", "unknown_op", "управление: op «"+r.Op+"»")
	}
}

type listItem struct {
	ID       string `json:"id"`
	Pid      int    `json:"pid"`
	Attached bool   `json:"attached"`
	Buffered int    `json:"buffered"`
}

func (k *Keeper) list() []listItem {
	k.mu.Lock()
	ps := make([]*proc, 0, len(k.procs))
	for _, p := range k.procs {
		ps = append(ps, p)
	}
	k.mu.Unlock()
	sort.Slice(ps, func(a, b int) bool { return ps[a].id < ps[b].id })
	out := make([]listItem, 0, len(ps))
	for _, p := range ps {
		p.mu.Lock()
		out = append(out, listItem{ID: p.id, Pid: p.pid, Attached: p.conn != nil, Buffered: len(p.buf)})
		p.mu.Unlock()
	}
	return out
}

// exited — событие на соединение управления; без Host — ждёт в памяти.
func (k *Keeper) exited(b []byte) {
	k.mu.Lock()
	ctl := k.control
	if ctl == nil {
		k.queued = append(k.queued, b)
	}
	k.mu.Unlock()
	if ctl != nil {
		ctl.send(b)
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
