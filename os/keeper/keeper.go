package main

// keeper — исполнитель плана машины. План спускается сверху («выпуски»): какие части стоят на машине, какой версии,
// включены ли, их окружение. keeper сам ничего не решает: скачивает, сверяет, распаковывает, переключает части,
// держит каждую через держатель, отвечает keeper.state, пишет строки part.updated и part.failed в журнал флота,
// подменяет себя. Последний план хранит на диске и исполняет его и без связи.
import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed module.json
var manifest []byte

// keeperVersion — версия keeper: при сборке выпуска её ставит -ldflags "-X main.buildVersion=…", иначе — module.json.
var keeperVersion = func() string {
	if buildVersion != "" {
		return buildVersion
	}
	var m struct{ Version string }
	json.Unmarshal(manifest, &m)
	return m.Version
}()

var buildVersion string

// planPart — часть в плане машины: stable уже раскрыт в версию, ссылка на архив живёт час.
type planPart struct {
	Part    string            `json:"part"`
	Version string            `json:"version"`
	Sha256  string            `json:"sha256"`
	URL     string            `json:"url"`
	On      *bool             `json:"on,omitempty"`
	Force   bool              `json:"force,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

func (p planPart) on() bool { return p.On == nil || *p.On }

type plan struct {
	Rev   int        `json:"rev"`
	Parts []planPart `json:"parts"`
}

func (pl *plan) find(name string) (planPart, bool) {
	for _, p := range pl.Parts {
		if p.Part == name {
			return p, true
		}
	}
	return planPart{}, false
}

// part — часть машины под держателем.
type part struct {
	name     string
	version  string // версия запущенного процесса или стоящая, если не запущен
	conn     *heldConn
	pid      int
	state    string // running, stopping, stopped, failed
	restarts int
	err      string
	stopReq  bool          // выход просил keeper
	exited   chan struct{} // закрыт, когда процесс вышел
}

type Keeper struct {
	home, machine, node string
	j                   *Journal
	radio               *radio

	mu       sync.Mutex
	plan     plan // исполняемый
	parts    map[string]*part
	applyMu  sync.Mutex
	pending  chan plan
	stopping bool
	done     chan struct{}
	stopOnce sync.Once
	exitCode int

	// для стенда: свой файл (подмена себя) и выход процесса после подмены
	self func() (string, error)
	exit func(code int)
}

// Start — конфиг, журнал, сохранённый план, держатели с прошлой жизни, связь с рацией.
func Start(home string, echo io.Writer) (*Keeper, error) {
	conf, err := readConf(home)
	machine := confStr(conf, "machine")
	if machine == "" {
		hn, _ := os.Hostname()
		machine = strings.ToLower(hn)
	}
	j := newJournal(filepath.Join(home, "journal"), machine, echo)
	if err != nil {
		j.stop("keeper_start", "keeper.json не прочитан: "+err.Error())
		return nil, err
	}
	k := &Keeper{home: home, machine: machine, node: confStr(conf, "node"), j: j, parts: map[string]*part{},
		pending: make(chan plan, 1), done: make(chan struct{}), self: os.Executable, exit: os.Exit}
	j.note("keeper_start", "keeper", keeperVersion, "pid", os.Getpid(), "os", osName())
	if b, err := os.ReadFile(planPath(home)); err == nil {
		json.Unmarshal(b, &k.plan)
	}
	k.adopt()
	go k.applyLoop()
	k.queue(k.plan)
	if url, key := confStr(conf, "relay"), readKey(home); url != "" && key != "" {
		k.radio = newRadio(url, key)
		k.radio.onOpen = k.askPlan
		k.radio.onFrame = k.frame
		k.radio.onState = func(open bool, why string) {
			if open {
				k.j.note("relay_open")
			} else if why != "" {
				k.j.note("relay_closed", "why", why)
			}
		}
		go k.radio.run()
	} else {
		j.stop("relay", "в keeper.json нет relay или нет machine.key — исполняю сохранённый план без связи")
	}
	return k, nil
}

func planPath(home string) string { return filepath.Join(home, "plan.json") }

// readKey — ключ машины ~/.switchboard/machine.key: им входят и Host, и keeper (keeper — с part в hello).
func readKey(home string) string {
	b, err := os.ReadFile(filepath.Join(home, "machine.key"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func osName() string { return runtime.GOOS + " " + runtime.GOARCH }

// Done — закрыт, когда keeper остановился.
func (k *Keeper) Done() <-chan struct{} { return k.done }

// Stop — штатная остановка keeper: связь закрыта, держатели и их процессы живут дальше.
func (k *Keeper) Stop() {
	k.stopOnce.Do(func() {
		k.mu.Lock()
		k.stopping = true
		k.mu.Unlock()
		if k.radio != nil {
			k.radio.close()
		}
		k.mu.Lock()
		for _, p := range k.parts {
			if p.conn != nil {
				p.conn.Close()
			}
		}
		k.mu.Unlock()
		k.j.note("keeper_exit")
		close(k.done)
	})
	<-k.done
}

/* ===== рация ===== */

// askPlan — при каждом подключении: вопрос о плане машины.
func (k *Keeper) askPlan() {
	r := k.radio.request(frameMsg{"type": "releases.plan", "v": 1, "to": ".releases"}, 30*time.Second)
	if !r.OK {
		k.j.refuse("plan", r.Error, "releases.plan не ответил: "+r.Error)
		return
	}
	var pl plan
	if err := json.Unmarshal(r.Result, &pl); err != nil {
		k.j.stop("plan", "ответ releases.plan не план: "+err.Error())
		return
	}
	k.queue(pl)
}

// frame — кадр рации: план от «выпусков» или запрос keeper.state.
func (k *Keeper) frame(f frameMsg) {
	switch f.str("type") {
	case "releases.plan":
		if f.str("from") != ".releases" {
			k.j.refuse("plan", "bad_from", "план не от .releases: "+f.str("from"))
			return
		}
		b, _ := json.Marshal(f)
		var pl plan
		json.Unmarshal(b, &pl)
		k.queue(pl)
	case "keeper.state":
		k.radio.answer(f, k.state(), "")
	default:
		if f.str("id") != "" {
			k.radio.answer(f, nil, "unknown_request")
		}
	}
}

// ledger — строка в журнал флота; нет связи — только в журнал машины.
func (k *Keeper) ledger(ev, text string) {
	if k.radio == nil {
		return
	}
	if err := k.radio.send(frameMsg{"type": "ledger.add", "v": 1, "to": ".ledger", "ev": ev, "text": text, "machine": k.machine}); err != nil {
		k.j.note("ledger", "ev", ev, "why", "нет связи: "+text)
	}
}

/* ===== состояние ===== */

type partState struct {
	Part     string `json:"part"`
	Version  string `json:"version,omitempty"`
	State    string `json:"state"`
	Pid      int    `json:"pid,omitempty"`
	Restarts int    `json:"restarts"`
	Error    string `json:"error,omitempty"`
}

type keeperState struct {
	Keeper string      `json:"keeper"`
	Rev    int         `json:"rev"`
	OS     string      `json:"os"`
	Parts  []partState `json:"parts"`
}

// state — ответ keeper.state: только о частях своего плана.
func (k *Keeper) state() keeperState {
	k.mu.Lock()
	defer k.mu.Unlock()
	s := keeperState{Keeper: keeperVersion, Rev: k.plan.Rev, OS: osName(), Parts: []partState{}}
	names := make([]string, 0, len(k.parts))
	for n := range k.parts {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		p := k.parts[n]
		s.Parts = append(s.Parts, partState{Part: n, Version: p.version, State: p.state, Pid: p.pid, Restarts: p.restarts, Error: p.err})
	}
	return s
}

/* ===== исполнение плана ===== */

// queue — план на исполнение: из ожидающих берётся с большей rev; меньшая или та же rev — пропуск.
func (k *Keeper) queue(pl plan) {
	// force — сразу, мимо очереди: прежняя правка может ждать выхода упрямой части без таймера
	for _, pp := range pl.Parts {
		if !pp.Force || pp.on() {
			continue
		}
		k.mu.Lock()
		p := k.parts[pp.Part]
		var c *heldConn
		if p != nil && p.state == "stopping" {
			c = p.conn
		}
		k.mu.Unlock()
		if c != nil {
			k.j.note("force", "part", pp.Part)
			c.kill()
		}
	}
	select {
	case old := <-k.pending:
		if old.Rev > pl.Rev {
			pl = old
		}
	default:
	}
	k.pending <- pl
}

func (k *Keeper) applyLoop() {
	first := true
	for {
		select {
		case <-k.done:
			return
		case pl := <-k.pending:
			k.mu.Lock()
			cur := k.plan.Rev
			k.mu.Unlock()
			// сохранённый план исполняется на старте; дальше — только новее исполняемого
			if !first && pl.Rev <= cur {
				continue
			}
			first = false
			k.apply(pl)
		}
	}
}

func (k *Keeper) apply(pl plan) {
	k.applyMu.Lock()
	defer k.applyMu.Unlock()
	k.mu.Lock()
	old := k.plan
	k.plan = pl
	k.mu.Unlock()
	if b, err := json.MarshalIndent(pl, "", "  "); err == nil {
		tmp := planPath(k.home) + ".tmp"
		if os.WriteFile(tmp, append(b, '\n'), 0o600) == nil {
			os.Rename(tmp, planPath(k.home))
		}
	}
	k.j.note("plan", "rev", pl.Rev, "parts", len(pl.Parts))
	var self *planPart
	for i := range pl.Parts {
		p := pl.Parts[i]
		if p.Part == "keeper" {
			self = &pl.Parts[i]
			continue
		}
		prev, had := old.find(p.Part)
		k.applyPart(p, prev, had)
	}
	// части, которых нет в плане: остановить и снять, data/ остаётся
	k.mu.Lock()
	var gone []string
	for n := range k.parts {
		if _, ok := pl.find(n); !ok {
			gone = append(gone, n)
		}
	}
	k.mu.Unlock()
	for _, n := range gone {
		k.removePart(n)
	}
	// keeper — последним: подмена себя кончается выходом
	if self != nil && self.Version != "" && self.Version != keeperVersion {
		k.selfUpdate(*self)
	}
}

func (k *Keeper) partOf(name string) *part {
	k.mu.Lock()
	defer k.mu.Unlock()
	p := k.parts[name]
	if p == nil {
		p = &part{name: name, state: "stopped"}
		k.parts[name] = p
	}
	return p
}

func (k *Keeper) applyPart(pp planPart, prev planPart, had bool) {
	p := k.partOf(pp.Part)
	k.mu.Lock()
	running := p.conn != nil && p.state != "stopped" && p.state != "failed"
	runVer := p.version
	failed := p.state == "failed"
	exited := p.state == "exited"
	k.mu.Unlock()
	if exited {
		return // выход разбирает его обработчик
	}
	// failed остаётся failed, пока запись части в плане не поменялась: решает тот, кто правит план
	if failed && had && samePart(pp, prev) {
		return
	}
	if !pp.on() {
		if running {
			k.stopPart(p, pp.Force)
		}
		k.mu.Lock()
		p.state, p.restarts, p.err = "stopped", 0, ""
		k.mu.Unlock()
		return
	}
	if running && runVer == pp.Version && !pp.Force {
		return
	}
	dir, err := k.install(pp)
	if err != nil {
		k.mu.Lock()
		p.err = err.Error()
		if !running {
			p.state = "failed"
		}
		k.mu.Unlock()
		k.j.stop("install", err.Error(), "part", pp.Part, "version", pp.Version)
		return
	}
	if running {
		k.stopPart(p, pp.Force)
	}
	k.mu.Lock()
	p.restarts, p.err = 0, ""
	k.mu.Unlock()
	if err := k.startPart(p, pp, dir); err != nil {
		k.failPart(p, pp.Version, "запуск: "+err.Error())
		return
	}
	if running && runVer != pp.Version {
		k.j.note("part_updated", "part", pp.Part, "from", runVer, "to", pp.Version)
		k.ledger("part.updated", fmt.Sprintf("%s: %s %s → %s", k.machine, pp.Part, runVer, pp.Version))
	}
	k.cleanupVersions(pp.Part, pp.Version, runVer)
}

// stopPart — закрыть ввод и ждать выхода без таймера; force — убить дерево сразу.
func (k *Keeper) stopPart(p *part, force bool) {
	k.mu.Lock()
	c, ch := p.conn, p.exited
	p.stopReq = true
	p.state = "stopping"
	k.mu.Unlock()
	if c == nil {
		return
	}
	if force {
		c.kill()
	} else {
		c.closeInput()
	}
	if ch != nil {
		<-ch
	}
}

func (k *Keeper) removePart(name string) {
	k.mu.Lock()
	p := k.parts[name]
	k.mu.Unlock()
	if p == nil {
		return
	}
	k.stopPart(p, false)
	k.mu.Lock()
	delete(k.parts, name)
	k.mu.Unlock()
	es, _ := os.ReadDir(partDir(k.home, name))
	for _, e := range es {
		if e.IsDir() && e.Name() != "data" {
			os.RemoveAll(filepath.Join(partDir(k.home, name), e.Name()))
		}
	}
	k.j.note("part_removed", "part", name)
}

// startPart — держатель с командой из app.json; вывод — строками в журнал машины.
func (k *Keeper) startPart(p *part, pp planPart, dir string) error {
	app, err := readApp(dir)
	if err != nil {
		return err
	}
	data := filepath.Join(partDir(k.home, pp.Part), "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		return err
	}
	self, _ := k.self()
	env := append(os.Environ(),
		"SWITCHBOARD_MACHINE="+k.machine,
		"SWITCHBOARD_HOLDER="+self,
		"SWITCHBOARD_PART="+pp.Part,
		"SWITCHBOARD_VERSION="+pp.Version,
		"SWITCHBOARD_DATA="+data,
		"SWITCHBOARD_HOME="+k.home,
	)
	if conf, _ := readConf(k.home); confStr(conf, "relay") != "" {
		env = append(env, "SWITCHBOARD_RELAY="+confStr(conf, "relay"))
	}
	for kk, v := range pp.Env {
		env = append(env, kk+"="+v)
	}
	f, err := spawnHolder(k.home, holdSpec{ID: pp.Part, Owner: "keeper", Tag: pp.Version, Cwd: data, Env: env, Detach: app.DetachChildren, Cmd: k.command(app.Run, dir)})
	if err != nil {
		return err
	}
	c, hh, err := dialHolder(f)
	if err != nil {
		return err
	}
	k.attach(p, c, hh.Pid, pp.Version)
	k.j.note("part_start", "part", pp.Part, "version", pp.Version, "pid", hh.Pid)
	return nil
}

// command — run или setup из app.json: node — Node из keeper.json, npm — npm-cli.js рядом с ним под тем же Node
// (на Windows npm — это npm.cmd, а у службы может не быть PATH); пути — от папки версии.
func (k *Keeper) command(run []string, dir string) []string {
	out := make([]string, 0, len(run)+1)
	for i, a := range run {
		switch {
		case i == 0 && a == "node" && k.node != "":
			out = append(out, k.node)
		case i == 0 && a == "npm" && npmCli(k.node) != "":
			out = append(out, k.node, npmCli(k.node))
		case !filepath.IsAbs(a) && exists(filepath.Join(dir, a)):
			out = append(out, filepath.Join(dir, a))
		default:
			out = append(out, a)
		}
	}
	return out
}

// npmCli — npm-cli.js рядом с Node: Windows — <папка node>/node_modules/npm, Linux — <папка node>/../lib/node_modules/npm.
func npmCli(node string) string {
	if node == "" {
		return ""
	}
	d := filepath.Dir(node)
	for _, p := range []string{filepath.Join(d, "node_modules", "npm", "bin", "npm-cli.js"), filepath.Join(d, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")} {
		if exists(p) {
			return p
		}
	}
	return ""
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// attach — часть ведёт держатель c: читать его кадры до выхода процесса.
func (k *Keeper) attach(p *part, c *heldConn, pid int, version string) {
	ch := make(chan struct{})
	k.mu.Lock()
	p.conn, p.pid, p.version, p.state, p.stopReq, p.exited = c, pid, version, "running", false, ch
	k.mu.Unlock()
	go func() {
		var line []byte
		x, err := c.read(func(b []byte) {
			line = append(line, b...)
			for {
				i := indexByte(line, '\n')
				if i < 0 {
					break
				}
				k.j.note("out", "part", p.name, "line", strings.TrimRight(string(line[:i]), "\r"))
				line = line[i+1:]
			}
		})
		c.Close()
		k.mu.Lock()
		stopping := k.stopping
		k.mu.Unlock()
		if stopping && x == nil {
			return // keeper останавливается: держатель живёт дальше
		}
		if x == nil {
			x = &exitInfoJSON{Stderr: "связь с держателем оборвалась: " + errText(err)}
		}
		k.exitedPart(p, ch, *x)
	}()
}

func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// exitedPart — процесс части вышел. По просьбе — stopped; сам — один перезапуск, второй раз — failed.
func (k *Keeper) exitedPart(p *part, ch chan struct{}, x exitInfoJSON) {
	k.mu.Lock()
	if p.exited != ch {
		k.mu.Unlock()
		return
	}
	p.conn, p.pid, p.exited = nil, 0, nil
	asked := p.stopReq
	if asked {
		p.state = "stopped"
	} else {
		// выход разбирает этот обработчик: исполнение плана часть не трогает
		p.state = "exited"
	}
	restarts := p.restarts
	version := p.version
	stopping := k.stopping
	k.mu.Unlock()
	close(ch)
	words := exitWords(x.Code, x.Signal, x.Stderr)
	if asked || stopping {
		k.j.note("part_exit", "part", p.name, "version", version, "why", words)
		return
	}
	k.j.stop("part_exit", fmt.Sprintf("%s %s вышла сама: %s", p.name, version, words), "part", p.name, "version", version)
	// под тем же замком, что исполнение плана: второго экземпляра не бывает; план — нынешний
	k.applyMu.Lock()
	defer k.applyMu.Unlock()
	k.mu.Lock()
	pp, ok := k.plan.find(p.name)
	k.mu.Unlock()
	if !ok || !pp.on() {
		k.mu.Lock()
		p.state = "stopped"
		k.mu.Unlock()
		return
	}
	if restarts > 0 {
		k.failPart(p, version, "второе падение: "+words)
		return
	}
	k.mu.Lock()
	p.restarts = 1
	k.mu.Unlock()
	dir, err := k.install(pp)
	if err == nil {
		err = k.startPart(p, pp, dir)
	}
	if err != nil {
		k.failPart(p, pp.Version, "перезапуск: "+err.Error())
	}
}

func (k *Keeper) failPart(p *part, version, why string) {
	k.mu.Lock()
	p.state, p.err, p.version = "failed", why, version
	k.mu.Unlock()
	k.j.stop("part_failed", p.name+" "+version+": "+why, "part", p.name, "version", version)
	k.ledger("part.failed", fmt.Sprintf("%s: %s %s — %s", k.machine, p.name, version, why))
}

func exitWords(code *int, sig *string, lastErr string) string {
	s := ""
	switch {
	case sig != nil:
		s = "сигнал " + *sig
	case code != nil:
		s = fmt.Sprintf("код %d", *code)
	}
	if lastErr != "" {
		if s != "" {
			s += ", "
		}
		s += lastErr
	}
	return s
}

// adopt — на старте: держатели keeper с прошлой жизни. Есть в плане — подключиться, нет — убить.
func (k *Keeper) adopt() {
	for _, f := range readHoldFiles(k.home) {
		if f.Owner != "keeper" {
			continue
		}
		c, hh, err := dialHolder(f)
		if err != nil {
			k.j.note("adopt", "id", f.ID, "why", "держатель не отвечает — файл убран: "+err.Error())
			os.Remove(holdPath(k.home, f.ID))
			continue
		}
		pp, ok := k.plan.find(f.ID)
		if !ok || f.ID == "keeper" {
			k.j.note("orphan_kill", "id", f.ID, "why", "части нет в плане")
			c.kill()
			go func() { c.read(func([]byte) {}); c.Close() }()
			continue
		}
		p := k.partOf(pp.Part)
		k.attach(p, c, hh.Pid, f.Tag)
		k.j.note("adopt", "id", f.ID, "pid", hh.Pid, "version", f.Tag, "buffered", hh.Buffered)
	}
}

// cleanupVersions — папки версий части, кроме текущей и предыдущей; занятую ОС не даёт удалить — остаётся до следующей.
func (k *Keeper) cleanupVersions(name, cur, prev string) {
	es, _ := os.ReadDir(partDir(k.home, name))
	for _, e := range es {
		n := e.Name()
		if !e.IsDir() || n == "data" || n == cur || n == prev {
			continue
		}
		if err := os.RemoveAll(filepath.Join(partDir(k.home, name), n)); err != nil {
			k.j.note("cleanup", "part", name, "version", n, "why", "занята: "+err.Error())
		}
	}
}

// samePart — запись части в плане та же (ссылка не в счёт: она живёт час).
func samePart(a, b planPart) bool {
	ea, _ := json.Marshal(a.Env)
	eb, _ := json.Marshal(b.Env)
	return a.Version == b.Version && a.Sha256 == b.Sha256 && a.on() == b.on() && a.Force == b.Force && string(ea) == string(eb)
}
