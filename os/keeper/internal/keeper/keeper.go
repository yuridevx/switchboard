// Package keeper — исполнитель плана машины. План спускается сверху («выпуски»): какие части стоят на машине, какой версии, включены ли, их окружение.
// keeper сам ничего не решает: ставит версии, держит каждую часть через держатель, отвечает keeper.state, пишет part.updated и part.failed в журнал
// флота, подменяет себя. Последний план хранит на диске и исполняет его и без связи.
package keeper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"switchboard/keeper/internal/holder"
	"switchboard/keeper/internal/journal"
	"switchboard/keeper/internal/link"
	"switchboard/keeper/internal/machine"
	"switchboard/keeper/internal/release"
)

// Options — пределы и свой файл. Ноль — значения работы.
type Options struct {
	Version string
	// StopLimit — выход части после «закрой ввод» и после «убей», setup версии, проверка нового файла keeper: 1 мин — больше предела остановки Host (30 с)
	// и вдвое выше самой долгой установки Host (21 с)
	StopLimit, PlanWait, Ping, PauseFirst, PauseMax, Download, HolderWait time.Duration
	Self                                                                  func() (string, error)
}

func (o *Options) fill() {
	def := func(d *time.Duration, v time.Duration) {
		if *d == 0 {
			*d = v
		}
	}
	def(&o.StopLimit, time.Minute)
	def(&o.PlanWait, 30*time.Second)
	def(&o.Ping, 30*time.Second)
	def(&o.PauseFirst, time.Second)
	def(&o.PauseMax, time.Minute)
	def(&o.Download, 10*time.Minute)
	def(&o.HolderWait, 5*time.Second)
	if o.Self == nil {
		o.Self = os.Executable
	}
}

// Состояния части в keeper.state. exited — вышла сама и ждёт разбора, пока цикл занят планом.
const (
	running  = "running"
	stopping = "stopping"
	stopped  = "stopped"
	exited   = "exited"
	failed   = "failed"
)

// part — часть машины.
type part struct {
	name     string
	version  string // запущенная или стоящая версия
	state    string
	restarts int
	err      string
	conn     *holder.Conn
	pid      int
	asked    bool          // выход просил keeper
	out      chan struct{} // закрыт, когда процесс вышел
}

func (p *part) alive() bool { return p.conn != nil && p.state != stopped && p.state != failed }

// Keeper — исполнитель.
type Keeper struct {
	o                  Options
	home, machine, key string
	workers            map[string]string // Worker'ы флота из keeper.json; части получают карту в окружении
	j                  *journal.Journal
	in                 *release.Installer
	relay              *link.Relay
	bg                 context.Context // отменён на остановке
	cancel             context.CancelFunc

	mu    sync.Mutex
	plan  Plan
	next  *Plan // пришедший и ещё не исполненный: из двух остаётся с большей rev
	parts map[string]*part

	wake chan struct{} // пришёл план или часть вышла сама
	work sync.WaitGroup
	done chan struct{}
	once sync.Once
}

// New — настройка, журнал и сохранённый план; ничего ещё не запущено. keeper.json не прочитан — отказ и строка журнала.
func New(home string, echo io.Writer, o Options) (*Keeper, error) {
	o.fill()
	conf, err := machine.ReadConf(home)
	key := machine.Key(home)
	name := machine.NameOf(key)
	j := journal.New(machine.JournalDir(home), name, echo)
	if err != nil {
		j.Stop("keeper_start", "keeper.json не прочитан: "+err.Error())
		return nil, err
	}
	bg, cancel := context.WithCancel(context.Background())
	k := &Keeper{o: o, home: home, machine: name, key: key, workers: conf.Workers(), j: j, bg: bg, cancel: cancel,
		parts: map[string]*part{}, wake: make(chan struct{}, 1), done: make(chan struct{})}
	k.in = &release.Installer{Home: home, Node: conf.Node(), Client: &http.Client{Timeout: o.Download}, SetupLimit: o.StopLimit, J: j}
	j.Note("keeper_start", "keeper", o.Version, "pid", os.Getpid(), "os", osName())
	if b, err := os.ReadFile(machine.PlanPath(home)); err == nil {
		if err := json.Unmarshal(b, &k.plan); err != nil {
			k.plan = Plan{}
			j.Stop("plan", "plan.json не разобран — план пустой до плана от «выпусков», держатели частей сняты как ничьи: "+err.Error())
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		j.Stop("plan", "plan.json не прочитан — план пустой до плана от «выпусков»: "+err.Error())
	}
	return k, nil
}

func osName() string { return runtime.GOOS + " " + runtime.GOARCH }

// Run — держатели с прошлой жизни, исполнение сохранённого плана, связь с relay своей машины.
func (k *Keeper) Run() {
	if self, err := k.o.Self(); err == nil {
		release.CleanOld(self)
	}
	k.adopt()
	k.work.Add(1)
	go k.loop()
	k.enqueue(k.plan)
	url := strings.TrimRight(k.workers["relay"], "/")
	if strings.HasPrefix(url, "http") {
		url = "ws" + strings.TrimPrefix(url, "http")
	}
	if url == "" || k.machine == "" {
		k.j.Stop("relay", "в keeper.json нет адреса relay (workers.relay) или нет machine.key — исполняю сохранённый план без связи")
		return
	}
	k.relay = &link.Relay{URL: url + "/m/" + k.machine, Key: k.key, Ping: k.o.Ping, PauseFirst: k.o.PauseFirst, PauseMax: k.o.PauseMax,
		OnOpen:  k.onRelayOpen,
		OnFrame: k.onFrame,
		OnClosed: func(why string) {
			if why != "" {
				k.j.Note("relay_closed", "why", why)
			}
		}}
	k.relay.Start()
}

// Done — закрыт, когда keeper остановился.
func (k *Keeper) Done() <-chan struct{} { return k.done }

// Stop — штатная остановка: нового не берёт, связь закрыта с причиной, свои горутины дописали журнал — keeper_exit последняя строка. Держатели и их
// процессы живут дальше. Цикл, занятый установкой, доводит её.
func (k *Keeper) Stop() {
	k.once.Do(func() {
		k.cancel()
		if k.relay != nil {
			k.relay.Close()
		}
		k.mu.Lock()
		for _, p := range k.parts {
			if p.conn != nil {
				p.conn.Close()
			}
		}
		k.mu.Unlock()
		k.work.Wait()
		k.j.Note("keeper_exit")
		close(k.done)
	})
	<-k.done
}

func (k *Keeper) stopping() bool { return k.bg.Err() != nil }

/* ===== связь ===== */

// onRelayOpen — при каждом подключении: план — POST «Выпускам» пропуском машины. Отказ или нет ответа — строка журнала; план придёт кадром releases.plan
// при перемене или при следующем соединении.
func (k *Keeper) onRelayOpen() {
	k.j.Note("relay_open")
	url := k.workers["releases"]
	if url == "" {
		k.j.Stop("plan", "в keeper.json нет адреса «Выпусков» (workers.releases) — исполняю сохранённый план")
		return
	}
	r := link.Post(k.bg, url, k.key, link.Frame{"type": "releases.plan", "id": "plan", "v": 1, "to": ".releases"}, k.o.PlanWait)
	if !r.OK {
		k.j.Refuse("plan", r.Error, "releases.plan не ответил: "+r.Error)
		return
	}
	k.takePlan(r.Result, "ответ releases.plan")
}

// takePlan — тело плана v1. Разбор строгий: чужое поле — отказ contract_mismatch.
func (k *Keeper) takePlan(body []byte, src string) {
	var pl Plan
	if err := release.Strict(body, &pl); err != nil {
		k.j.Refuse("plan", "contract_mismatch", src+" — не план v1: "+err.Error())
		return
	}
	k.enqueue(pl)
}

func (k *Keeper) onFrame(f link.Frame) {
	switch f.Str("type") {
	case "releases.plan":
		if f.Str("from") != ".releases" {
			k.j.Refuse("plan", "bad_from", "план не от .releases: "+f.Str("from"))
			return
		}
		if v, _ := f["v"].(float64); v != 1 {
			k.j.Refuse("plan", "contract_mismatch", fmt.Sprintf("кадр releases.plan v %v — не v1", f["v"]))
			return
		}
		// конверт принадлежит протоколу и relay; строгость — только к телу плана
		body := link.Frame{}
		for name, v := range f {
			switch name {
			case "type", "id", "v", "to", "from":
			default:
				body[name] = v
			}
		}
		b, _ := json.Marshal(body)
		k.takePlan(b, "кадр releases.plan")
	case "keeper.state":
		k.relay.Answer(f, k.State(), "")
	default:
		if f.Str("id") != "" {
			k.relay.Answer(f, nil, "unknown_request")
		}
	}
}

// ledger — строка в журнал флота своей горутиной: цикл частей не ждёт; не дошла — только в журнал машины. Остановка ждёт её до предела запроса: последняя
// строка перед выходом (подмена себя) доходит.
func (k *Keeper) ledger(ev, text string) {
	url := k.workers["ledger"]
	if url == "" {
		k.j.Note("ledger", "event", ev, "why", "нет адреса журнала (workers.ledger): "+text)
		return
	}
	k.work.Add(1)
	go func() {
		defer k.work.Done()
		f := link.Frame{"type": "ledger.add", "v": 1, "to": ".ledger", "ev": ev, "text": text, "machine": k.machine}
		if r := link.Post(context.Background(), url, k.key, f, k.o.PlanWait); !r.OK {
			k.j.Note("ledger", "event", ev, "why", r.Error+": "+text)
		}
	}()
}

/* ===== состояние ===== */

// PartState — часть в keeper.state v1.
type PartState struct {
	Part     string `json:"part"`
	Version  string `json:"version,omitempty"`
	State    string `json:"state"`
	Pid      int    `json:"pid,omitempty"`
	Restarts int    `json:"restarts"`
	Error    string `json:"error,omitempty"`
}

// State — ответ keeper.state: только о частях своего плана.
type State struct {
	Keeper string      `json:"keeper"`
	Rev    int         `json:"rev"`
	OS     string      `json:"os"`
	Parts  []PartState `json:"parts"`
}

// State — keeper.state сейчас.
func (k *Keeper) State() State {
	k.mu.Lock()
	defer k.mu.Unlock()
	s := State{Keeper: k.o.Version, Rev: k.plan.Rev, OS: osName(), Parts: []PartState{}}
	for _, p := range k.parts {
		s.Parts = append(s.Parts, PartState{Part: p.name, Version: p.version, State: p.state, Pid: p.pid, Restarts: p.restarts, Error: p.err})
	}
	sort.Slice(s.Parts, func(a, b int) bool { return s.Parts[a].Part < s.Parts[b].Part })
	return s
}

/* ===== цикл ===== */

// enqueue — план на исполнение: из ожидающих берётся с большей rev. force — сразу, мимо очереди: прежняя правка может ждать выхода упрямой части.
func (k *Keeper) enqueue(pl Plan) {
	k.mu.Lock()
	for _, e := range pl.Parts {
		if p := k.parts[e.Part]; e.Force && !e.on() && p != nil && p.state == stopping && p.conn != nil {
			k.j.For(e.Part).Note("force")
			p.conn.Kill()
		}
	}
	if k.next == nil || pl.Rev > k.next.Rev {
		k.next = &pl
	}
	k.mu.Unlock()
	k.nudge()
}

func (k *Keeper) nudge() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

// loop — единственный исполнитель переходов частей: сначала новый план, затем части, вышедшие сами.
func (k *Keeper) loop() {
	defer k.work.Done()
	first := true
	for {
		select {
		case <-k.bg.Done():
			return
		case <-k.wake:
		}
		k.mu.Lock()
		pl, cur := k.next, k.plan.Rev
		k.next = nil
		k.mu.Unlock()
		// сохранённый план исполняется на старте; дальше — только новее исполняемого. Та же rev — переподключение, меньшая — «выпуски» потеряли счёт
		switch {
		case pl == nil:
		case first || pl.Rev > cur:
			first = false
			k.apply(*pl)
		case pl.Rev < cur:
			k.j.Refuse("plan", "old_rev", fmt.Sprintf("план rev %d старше исполняемого rev %d", pl.Rev, cur))
		}
		k.restartExited()
	}
}

func (k *Keeper) apply(pl Plan) {
	k.mu.Lock()
	old := k.plan
	k.plan = pl
	k.mu.Unlock()
	b, _ := json.MarshalIndent(pl, "", "  ")
	if err := machine.WriteAtomic(machine.PlanPath(k.home), append(b, '\n')); err != nil {
		k.j.Stop("plan", "plan.json не записан — после перезапуска keeper исполнит прежний: "+err.Error())
	}
	k.j.Note("plan", "rev", pl.Rev, "parts", len(pl.Parts))
	for _, e := range pl.Parts {
		if e.Part == "keeper" {
			continue
		}
		if k.stopping() {
			return
		}
		prev, had := old.find(e.Part)
		k.applyPart(e, prev, had)
	}
	k.mu.Lock()
	var gone []string
	for name := range k.parts {
		if _, ok := pl.find(name); !ok {
			gone = append(gone, name)
		}
	}
	k.mu.Unlock()
	for _, name := range gone {
		if k.stopping() {
			return
		}
		k.removePart(name)
	}
	// keeper — последним: подмена себя кончается выходом. Та же версия, что работает, — прежний сбой подмены (откат) больше не в силе
	if self, ok := pl.find("keeper"); ok && self.Version != "" {
		if self.Version == k.o.Version {
			k.mu.Lock()
			delete(k.parts, "keeper")
			k.mu.Unlock()
		} else {
			k.selfUpdate(self)
		}
	}
}

// slot — часть машины; нет — новая, остановленная.
func (k *Keeper) slot(name string) *part {
	k.mu.Lock()
	defer k.mu.Unlock()
	p := k.parts[name]
	if p == nil {
		p = &part{name: name, state: stopped}
		k.parts[name] = p
	}
	return p
}

func (k *Keeper) applyPart(e, prev Entry, had bool) {
	p := k.slot(e.Part)
	k.mu.Lock()
	alive, was, state := p.alive(), p.version, p.state
	k.mu.Unlock()
	// вышедшую сама цикл разберёт сразу после плана; failed остаётся failed, пока запись не поменялась: решает тот, кто правит план
	if state == exited || (state == failed && had && e.sameEntry(prev)) {
		return
	}
	if !e.on() {
		if alive && !k.stopPart(p, e.Force) {
			k.fail(p, was, "не вышла после «убей»")
			return
		}
		k.mu.Lock()
		p.state, p.restarts, p.err = stopped, 0, ""
		k.mu.Unlock()
		return
	}
	// работает та же версия с тем же окружением — делать нечего; новое окружение — перезапуск с ним
	if alive && was == e.Version && had && e.sameEnv(prev) {
		return
	}
	// версия годна, когда стоит и её app.json разобран: только тогда прежняя останавливается
	dir, err := k.in.Install(e.source())
	if err == nil {
		_, err = release.ReadApp(dir)
	}
	if err != nil {
		if !alive {
			k.fail(p, e.Version, err.Error())
			return
		}
		// прежняя версия работает: часть не failed, сбой — в keeper.state и журнал флота
		k.mu.Lock()
		p.err = err.Error()
		k.mu.Unlock()
		k.j.For(e.Part).Stop("install", err.Error(), "version", e.Version)
		k.ledger("part.failed", fmt.Sprintf("%s %s — %s", e.Part, e.Version, err.Error()))
		return
	}
	// остановка keeper, пока шла установка: работающая версия живёт дальше, переход — у следующего keeper
	if k.stopping() {
		return
	}
	if alive {
		ok := k.stopPart(p, false)
		if k.stopping() {
			return
		}
		// прежняя жива и после «убей»: новую не запускать — две версии разом
		if !ok {
			k.fail(p, was, "не вышла после «убей»")
			return
		}
	}
	k.mu.Lock()
	p.restarts, p.err = 0, ""
	k.mu.Unlock()
	if err := k.startPart(p, e, dir); err != nil {
		k.fail(p, e.Version, "запуск: "+err.Error())
		return
	}
	if alive && was != e.Version {
		k.j.For(e.Part).Note("part_updated", "from", was, "to", e.Version)
		k.ledger("part.updated", fmt.Sprintf("%s %s → %s", e.Part, was, e.Version))
	}
	k.cleanVersions(e.Part, e.Version, was)
}

// stopPart — закрыть ввод и ждать выхода не дольше предела: не вышла — строка stop_late и держатель убивает дерево (устав: «не успела — жёсткий выход»);
// force — убить сразу. Не вышла и после «убей» — false: новая версия не запускается. Остановка keeper прерывает ожидание.
func (k *Keeper) stopPart(p *part, force bool) bool {
	k.mu.Lock()
	c, out := p.conn, p.out
	p.asked, p.state = true, stopping
	k.mu.Unlock()
	if c == nil || out == nil {
		return true
	}
	if force {
		c.Kill()
	} else {
		c.CloseInput()
		if k.waitOut(out) || k.stopping() {
			return true
		}
		k.j.For(p.name).Stop("stop_late", fmt.Sprintf("%s %s не вышла за %v после «закрой ввод» — держатель убивает дерево", p.name, p.version, k.o.StopLimit))
		c.Kill()
	}
	if k.waitOut(out) || k.stopping() {
		return true
	}
	k.j.For(p.name).Stop("stop_late", fmt.Sprintf("%s %s не вышла и за %v после «убей»", p.name, p.version, k.o.StopLimit))
	return false
}

func (k *Keeper) waitOut(out <-chan struct{}) bool {
	late := time.NewTimer(k.o.StopLimit)
	defer late.Stop()
	select {
	case <-out:
		return true
	case <-k.bg.Done():
	case <-late.C:
	}
	return false
}

// removePart — части нет в плане: остановить и снять, data/ остаётся.
func (k *Keeper) removePart(name string) {
	p := k.slot(name)
	if !k.stopPart(p, false) {
		k.fail(p, p.version, "не вышла после «убей»")
		return
	}
	if k.stopping() {
		return
	}
	k.mu.Lock()
	delete(k.parts, name)
	k.mu.Unlock()
	es, _ := os.ReadDir(machine.PartDir(k.home, name))
	for _, e := range es {
		if e.IsDir() && e.Name() != "data" {
			os.RemoveAll(filepath.Join(machine.PartDir(k.home, name), e.Name()))
		}
	}
	k.j.For(name).Note("part_removed")
}

// startPart — держатель с командой из app.json; вывод — строками в журнал машины.
func (k *Keeper) startPart(p *part, e Entry, dir string) error {
	app, err := release.ReadApp(dir)
	if err != nil {
		return err
	}
	data := machine.DataDir(k.home, e.Part)
	if err := os.MkdirAll(data, 0o700); err != nil {
		return err
	}
	// держатели запускает этот же файл; часть зовёт его для своих держателей
	self, _ := os.Executable()
	env := append(os.Environ(), "SWITCHBOARD_MACHINE="+k.machine, "SWITCHBOARD_HOLDER="+self, "SWITCHBOARD_VERSION="+e.Version, "SWITCHBOARD_DATA="+data)
	if len(k.workers) > 0 {
		w, _ := json.Marshal(k.workers)
		env = append(env, "SWITCHBOARD_WORKERS="+string(w))
	}
	for name, v := range e.Env {
		env = append(env, name+"="+v)
	}
	f, err := holder.Spawn(k.home, holder.Spec{ID: e.Part, Owner: "keeper", Tag: e.Version, Cwd: data, Env: env, Detach: app.DetachChildren, Cmd: k.in.Command(app.Run, dir)}, k.o.HolderWait)
	if err != nil {
		return err
	}
	c, hello, err := holder.Dial(f, k.o.HolderWait)
	if err != nil {
		return err
	}
	k.attach(p, c, hello.Pid, e.Version)
	k.j.For(e.Part).Note("part_start", "version", e.Version, "pid", hello.Pid)
	return nil
}

// attach — часть ведёт держатель c: читать его кадры до выхода процесса.
func (k *Keeper) attach(p *part, c *holder.Conn, pid int, version string) {
	out := make(chan struct{})
	k.mu.Lock()
	p.conn, p.pid, p.version, p.state, p.asked, p.out = c, pid, version, running, false, out
	k.work.Add(1)
	k.mu.Unlock()
	// остановка уже закрыла соединения — это закрывается здесь же
	if k.stopping() {
		c.Close()
	}
	go func() {
		defer k.work.Done()
		var tail []byte
		j := k.j.For(p.name)
		x, err := c.Read(func(b []byte) {
			tail = append(tail, b...)
			for {
				line, rest, ok := strings.Cut(string(tail), "\n")
				if !ok {
					return
				}
				j.Note("out", "line", strings.TrimRight(line, "\r"))
				tail = []byte(rest)
			}
		})
		c.Close()
		if x == nil && k.stopping() {
			return // keeper останавливается: держатель живёт дальше
		}
		if x == nil {
			x = &holder.Exit{Stderr: "связь с держателем оборвалась: " + err.Error()}
		}
		k.onExit(p, out, *x)
	}()
}

// onExit — процесс части вышел. По просьбе keeper или по остановке ОС — stopped; сам — exited с причиной, разбирает цикл.
func (k *Keeper) onExit(p *part, out chan struct{}, x holder.Exit) {
	words := exitWords(x)
	k.mu.Lock()
	if p.out != out {
		k.mu.Unlock()
		return
	}
	p.conn, p.pid, p.out = nil, 0, nil
	// ОС останавливается раньше, чем об этом узнаёт служба keeper (win11-2 1 нояб.: держатель на 5 с раньше): такой выход — не падение, перезапуска нет
	asked := p.asked || x.OSStop
	if asked {
		p.state = stopped
	} else {
		p.state, p.err = exited, words
	}
	version := p.version
	k.mu.Unlock()
	close(out)
	j := k.j.For(p.name)
	if asked || k.stopping() {
		j.Note("part_exit", "version", version, "why", words)
		return
	}
	j.Stop("part_exit", fmt.Sprintf("%s %s вышла сама: %s", p.name, version, words), "version", version)
	k.nudge()
}

func exitWords(x holder.Exit) string {
	var w []string
	switch {
	case x.Signal != nil:
		w = append(w, "сигнал "+*x.Signal)
	case x.Code != nil:
		w = append(w, fmt.Sprintf("код %d", *x.Code))
	}
	if x.Stderr != "" {
		w = append(w, x.Stderr)
	}
	s := strings.Join(w, ", ")
	if x.OSStop {
		return "остановка ОС: " + s
	}
	return s
}

// restartExited — части, вышедшие сами, по нынешнему плану: один перезапуск, второй раз — failed; нет в плане или выключена — stopped.
func (k *Keeper) restartExited() {
	k.mu.Lock()
	var ps []*part
	for _, p := range k.parts {
		if p.state == exited {
			ps = append(ps, p)
		}
	}
	k.mu.Unlock()
	for _, p := range ps {
		if k.stopping() {
			return
		}
		k.mu.Lock()
		e, ok := k.plan.find(p.name)
		restarts, version, why := p.restarts, p.version, p.err
		if !ok || !e.on() {
			p.state, p.err = stopped, ""
		}
		k.mu.Unlock()
		switch {
		case !ok || !e.on():
		case restarts > 0:
			k.fail(p, version, "второе падение: "+why)
		default:
			k.mu.Lock()
			p.restarts, p.err = 1, ""
			k.mu.Unlock()
			dir, err := k.in.Install(e.source())
			if err == nil {
				err = k.startPart(p, e, dir)
			}
			if err != nil {
				k.fail(p, e.Version, "перезапуск: "+err.Error())
			}
		}
	}
}

func (k *Keeper) fail(p *part, version, why string) {
	k.mu.Lock()
	p.state, p.err, p.version = failed, why, version
	k.mu.Unlock()
	k.j.For(p.name).Stop("part_failed", p.name+" "+version+": "+why, "version", version)
	k.ledger("part.failed", fmt.Sprintf("%s %s — %s", p.name, version, why))
}

// adopt — на старте: держатели keeper с прошлой жизни. Есть в плане — подключиться, нет — убить. Держатели Host — не его.
func (k *Keeper) adopt() {
	for _, f := range holder.ReadFiles(k.home) {
		if f.Owner != "keeper" {
			continue
		}
		c, hello, err := holder.Dial(f, k.o.HolderWait)
		if err != nil {
			k.j.Note("adopt", "id", f.ID, "why", "держатель не отвечает — файл убран: "+err.Error())
			os.Remove(holder.Path(k.home, f.ID))
			continue
		}
		if _, ok := k.plan.find(f.ID); !ok || f.ID == "keeper" {
			k.j.Note("orphan_kill", "id", f.ID, "why", "части нет в плане")
			c.Kill()
			go func() {
				c.Read(func([]byte) {})
				c.Close()
			}()
			continue
		}
		k.attach(k.slot(f.ID), c, hello.Pid, f.Tag)
		k.j.Note("adopt", "id", f.ID, "pid", hello.Pid, "version", f.Tag, "buffered", hello.Buffered)
	}
}

// cleanVersions — папки версий части, кроме текущей и предыдущей; занятую ОС не даёт удалить — остаётся до следующей.
func (k *Keeper) cleanVersions(name, cur, prev string) {
	dir := machine.PartDir(k.home, name)
	es, _ := os.ReadDir(dir)
	for _, e := range es {
		n := e.Name()
		if !e.IsDir() || n == "data" || n == cur || n == prev {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, n)); err != nil {
			k.j.For(name).Note("cleanup", "version", n, "why", "занята: "+err.Error())
		}
	}
}
