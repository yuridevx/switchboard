package main

// keeper — исполнитель плана машины. План спускается сверху («выпуски»): какие части стоят на машине, какой версии,
// включены ли, их окружение. keeper сам ничего не решает: скачивает, сверяет, распаковывает, переключает части,
// держит каждую через держатель, отвечает keeper.state, пишет строки part.updated и part.failed в журнал флота,
// подменяет себя. Последний план хранит на диске и исполняет его и без связи.
import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
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
	state    string // running, stopping, stopped, exited (вышла сама — разбирает цикл), failed
	restarts int
	err      string
	stopReq  bool          // выход просил keeper
	exited   chan struct{} // закрыт, когда процесс вышел
}

type Keeper struct {
	home, machine, node string
	relay               string // адрес relay из keeper.json; части получают его в окружении
	j                   *Journal
	radio               *radio

	mu    sync.Mutex
	plan  plan  // исполняемый
	next  *plan // пришедший и ещё не исполненный: из двух остаётся с большей rev
	parts map[string]*part

	// переходы частей делает один цикл: сначала новый план, затем части, вышедшие сами
	wake     chan struct{}  // пришёл план или часть вышла сама
	quit     chan struct{}  // остановка: нового не берём
	wg       sync.WaitGroup // цикл и читатели частей: остановка ждёт, пока они допишут журнал
	done     chan struct{}
	stopOnce sync.Once

	// для стенда: свой файл (подмена себя), ожидание ответа на вопрос о плане, предел остановки части (больше предела Host 30 с)
	self     func() (string, error)
	planWait time.Duration
	stopWait time.Duration
}

// Start — конфиг, журнал, сохранённый план, держатели с прошлой жизни, связь с рацией.
func Start(home string, echo io.Writer) (*Keeper, error) {
	k, err := newKeeper(home, echo)
	if err != nil {
		return nil, err
	}
	k.run()
	return k, nil
}

// newKeeper — keeper с конфигом, журналом и сохранённым планом; ничего ещё не запущено.
func newKeeper(home string, echo io.Writer) (*Keeper, error) {
	conf, err := readConf(home)
	key := readKey(home)
	machine := machineOf(key)
	j := newJournal(filepath.Join(home, "journal"), machine, echo)
	if err != nil {
		j.stop("keeper_start", "keeper.json не прочитан: "+err.Error())
		return nil, err
	}
	k := &Keeper{home: home, machine: machine, relay: confStr(conf, "relay"), node: confStr(conf, "node"), j: j, parts: map[string]*part{},
		wake: make(chan struct{}, 1), quit: make(chan struct{}), done: make(chan struct{}),
		self: os.Executable, planWait: 30 * time.Second, stopWait: time.Minute}
	j.note("keeper_start", "keeper", keeperVersion, "pid", os.Getpid(), "os", osName())
	if b, err := os.ReadFile(planPath(home)); err == nil {
		if err := json.Unmarshal(b, &k.plan); err != nil {
			k.plan = plan{}
			j.stop("plan", "plan.json не разобран — план пустой до плана от «выпусков», держатели частей сняты как ничьи: "+err.Error())
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		j.stop("plan", "plan.json не прочитан — план пустой до плана от «выпусков»: "+err.Error())
	}
	return k, nil
}

// run — держатели с прошлой жизни, исполнение сохранённого плана, связь с рацией.
func (k *Keeper) run() {
	// прежние файлы keeper после подмены себя — на любом старте: консоль, служба, юнит
	if self, err := k.self(); err == nil {
		cleanupOldSelf(self)
	}
	k.adopt()
	k.wg.Add(1)
	go k.loop()
	k.queue(k.plan)
	if key := readKey(k.home); k.relay != "" && k.machine != "" {
		k.radio = newRadio(k.relay, key)
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
		k.j.stop("relay", "в keeper.json нет relay или нет machine.key — исполняю сохранённый план без связи")
	}
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

// machineOf — имя машины из её ключа host.<машина>.…: одно место, где оно записано. Ключа нет — "".
func machineOf(key string) string {
	if p := strings.Split(key, "."); len(p) > 2 && p[0] == "host" {
		return p[1]
	}
	return ""
}

func osName() string { return runtime.GOOS + " " + runtime.GOARCH }

// Done — закрыт, когда keeper остановился.
func (k *Keeper) Done() <-chan struct{} { return k.done }

// Stop — штатная остановка keeper: нового не берёт, связь закрыта с причиной, свои горутины дописали журнал —
// keeper_exit последняя строка. Держатели и их процессы живут дальше. Цикл, занятый установкой, доводит её.
func (k *Keeper) Stop() {
	k.stopOnce.Do(func() {
		close(k.quit)
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
		k.wg.Wait()
		k.j.note("keeper_exit")
		close(k.done)
	})
	<-k.done
}

// quitting — keeper останавливается.
func (k *Keeper) quitting() bool {
	select {
	case <-k.quit:
		return true
	default:
		return false
	}
}

/* ===== рация ===== */

// askPlan — при каждом подключении: вопрос о плане машины. Нет ответа — соединение закрыто:
// переподключение спросит снова.
func (k *Keeper) askPlan() {
	r := k.radio.request(frameMsg{"type": "releases.plan", "v": 1, "to": ".releases"}, k.planWait)
	if !r.OK {
		k.j.refuse("plan", r.Error, "releases.plan не ответил: "+r.Error)
		if r.Error == "timeout" {
			k.radio.drop("releases.plan не ответил")
		}
		return
	}
	k.takePlan(r.Result, "ответ releases.plan")
}

// takePlan — тело плана v1 от «выпусков» в очередь. Разбор строгий: чужое поле — отказ contract_mismatch.
func (k *Keeper) takePlan(body []byte, src string) {
	var pl plan
	if err := strictJSON(body, &pl); err != nil {
		k.j.refuse("plan", "contract_mismatch", src+" — не план v1: "+err.Error())
		return
	}
	k.queue(pl)
}

// strictJSON — разбор контракта v1: незнакомое поле — ошибка, замороженный keeper не исполняет того, чего не знает.
func strictJSON(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	return d.Decode(v)
}

// frame — кадр рации: план от «выпусков» или запрос keeper.state.
func (k *Keeper) frame(f frameMsg) {
	switch f.str("type") {
	case "releases.plan":
		if f.str("from") != ".releases" {
			k.j.refuse("plan", "bad_from", "план не от .releases: "+f.str("from"))
			return
		}
		if v, _ := f["v"].(float64); v != 1 {
			k.j.refuse("plan", "contract_mismatch", fmt.Sprintf("кадр releases.plan v %v — не v1", f["v"]))
			return
		}
		// конверт принадлежит протоколу и relay; строгость — только к телу плана
		body := frameMsg{}
		for kk, vv := range f {
			switch kk {
			case "type", "id", "v", "to", "from":
			default:
				body[kk] = vv
			}
		}
		b, _ := json.Marshal(body)
		k.takePlan(b, "кадр releases.plan")
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

// partState — часть в keeper.state v1. state: running, stopping, stopped, failed;
// exited — вышла сама и ждёт разбора, пока цикл занят планом.
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
	k.mu.Lock()
	if k.next == nil || pl.Rev > k.next.Rev {
		k.next = &pl
	}
	k.mu.Unlock()
	k.nudge()
}

// nudge — разбудить цикл: пришёл план или часть вышла сама.
func (k *Keeper) nudge() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

// loop — единственный исполнитель переходов частей: сначала новый план, затем части, вышедшие сами.
func (k *Keeper) loop() {
	defer k.wg.Done()
	first := true
	for {
		select {
		case <-k.quit:
			return
		case <-k.wake:
		}
		if k.quitting() {
			return
		}
		k.mu.Lock()
		pl, cur := k.next, k.plan.Rev
		k.next = nil
		k.mu.Unlock()
		// сохранённый план исполняется на старте; дальше — только новее исполняемого. Та же rev — переподключение,
		// меньшая — «выпуски» потеряли счёт: такой план не исполняется, строка в журнале
		switch {
		case pl == nil:
		case first || pl.Rev > cur:
			first = false
			k.apply(*pl)
		case pl.Rev < cur:
			k.j.refuse("plan", "old_rev", fmt.Sprintf("план rev %d старше исполняемого rev %d", pl.Rev, cur))
		}
		k.restartExited()
	}
}

func (k *Keeper) apply(pl plan) {
	k.mu.Lock()
	old := k.plan
	k.plan = pl
	k.mu.Unlock()
	b, _ := json.MarshalIndent(pl, "", "  ")
	if err := writeFileAtomic(planPath(k.home), append(b, '\n')); err != nil {
		k.j.stop("plan", "plan.json не записан — после перезапуска keeper исполнит прежний: "+err.Error())
	}
	k.j.note("plan", "rev", pl.Rev, "parts", len(pl.Parts))
	var self *planPart
	for i := range pl.Parts {
		p := pl.Parts[i]
		if p.Part == "keeper" {
			self = &pl.Parts[i]
			continue
		}
		if k.quitting() {
			return
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
		if k.quitting() {
			return
		}
		k.removePart(n)
	}
	// keeper — последним: подмена себя кончается выходом. План с той же версией, что работает, — прежний сбой подмены
	// (откат) больше не в силе
	if self != nil && self.Version == keeperVersion {
		k.mu.Lock()
		delete(k.parts, "keeper")
		k.mu.Unlock()
	}
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
		return // вышедшую сама цикл разберёт сразу после плана — по этому же плану
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
	// работает та же версия с тем же окружением — делать нечего; новое окружение — перезапуск с ним
	if running && runVer == pp.Version && had && sameEnv(pp, prev) {
		return
	}
	// версия годна, когда стоит и её app.json разобран: только тогда прежняя останавливается
	dir, err := k.install(pp)
	if err == nil {
		_, err = readApp(dir)
	}
	if err != nil {
		if !running {
			k.failPart(p, pp.Version, err.Error())
			return
		}
		// прежняя версия работает: часть не failed, сбой — в keeper.state и журнал флота
		k.mu.Lock()
		p.err = err.Error()
		k.mu.Unlock()
		k.j.stop("install", err.Error(), "part", pp.Part, "version", pp.Version)
		k.ledger("part.failed", fmt.Sprintf("%s %s — %s", pp.Part, pp.Version, err.Error()))
		return
	}
	// остановка keeper, пока шла установка: работающая версия живёт дальше, переход — у следующего keeper
	if k.quitting() {
		return
	}
	if running {
		k.stopPart(p, false)
		if k.quitting() {
			return
		}
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
		k.ledger("part.updated", fmt.Sprintf("%s %s → %s", pp.Part, runVer, pp.Version))
	}
	k.cleanupVersions(pp.Part, pp.Version, runVer)
}

// stopPart — закрыть ввод и ждать выхода не дольше stopWait: не вышла — строка stop_late и держатель убивает дерево
// (устав: «не успела — жёсткий выход»); force — убить сразу. Остановка keeper прерывает ожидание.
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
	if ch == nil {
		return
	}
	late := time.NewTimer(k.stopWait)
	defer late.Stop()
	select {
	case <-ch:
		return
	case <-k.quit:
		return
	case <-late.C:
	}
	k.j.stop("stop_late", fmt.Sprintf("%s %s не вышла за %v после «закрой ввод» — держатель убивает дерево", p.name, p.version, k.stopWait), "part", p.name)
	c.kill()
	select {
	case <-ch:
	case <-k.quit:
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
	if k.quitting() {
		return
	}
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
	// держатели запускает этот же файл — как spawnHolder
	self, _ := os.Executable()
	env := append(os.Environ(),
		"SWITCHBOARD_MACHINE="+k.machine,
		"SWITCHBOARD_HOLDER="+self,
		"SWITCHBOARD_VERSION="+pp.Version,
		"SWITCHBOARD_DATA="+data,
	)
	if k.relay != "" {
		env = append(env, "SWITCHBOARD_RELAY="+k.relay)
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
	// остановка уже закрыла соединения — это закрывается здесь же
	if k.quitting() {
		c.Close()
	}
	k.wg.Add(1)
	k.mu.Unlock()
	go func() {
		defer k.wg.Done()
		var line []byte
		x, err := c.read(func(b []byte) {
			line = append(line, b...)
			for {
				i := bytes.IndexByte(line, '\n')
				if i < 0 {
					break
				}
				k.j.note("out", "part", p.name, "line", strings.TrimRight(string(line[:i]), "\r"))
				line = line[i+1:]
			}
		})
		c.Close()
		if x == nil && k.quitting() {
			return // keeper останавливается: держатель живёт дальше
		}
		if x == nil {
			x = &exitInfoJSON{Stderr: "связь с держателем оборвалась: " + errText(err)}
		}
		k.exitedPart(p, ch, *x)
	}()
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// exitedPart — процесс части вышел. По просьбе keeper или по остановке ОС — stopped; сам — exited с причиной,
// разбирает цикл.
func (k *Keeper) exitedPart(p *part, ch chan struct{}, x exitInfoJSON) {
	words := exitWords(x.Code, x.Signal, x.Stderr)
	if x.OSStop {
		words = "остановка ОС: " + words
	}
	k.mu.Lock()
	if p.exited != ch {
		k.mu.Unlock()
		return
	}
	p.conn, p.pid, p.exited = nil, 0, nil
	// ОС останавливается раньше, чем об этом узнаёт служба keeper (win11-2 1 нояб.: держатель на 5 с раньше):
	// такой выход — не падение, перезапуска нет
	asked := p.stopReq || x.OSStop
	if asked {
		p.state = "stopped"
	} else {
		p.state, p.err = "exited", words
	}
	version := p.version
	k.mu.Unlock()
	close(ch)
	if asked || k.quitting() {
		k.j.note("part_exit", "part", p.name, "version", version, "why", words)
		return
	}
	k.j.stop("part_exit", fmt.Sprintf("%s %s вышла сама: %s", p.name, version, words), "part", p.name, "version", version)
	k.nudge()
}

// restartExited — части, вышедшие сами, по нынешнему плану: один перезапуск, второй раз — failed;
// нет в плане или выключена — stopped.
func (k *Keeper) restartExited() {
	k.mu.Lock()
	var ps []*part
	for _, p := range k.parts {
		if p.state == "exited" {
			ps = append(ps, p)
		}
	}
	k.mu.Unlock()
	for _, p := range ps {
		if k.quitting() {
			return
		}
		k.mu.Lock()
		pp, ok := k.plan.find(p.name)
		restarts, version, why := p.restarts, p.version, p.err
		if !ok || !pp.on() {
			p.state, p.err = "stopped", ""
		}
		k.mu.Unlock()
		if !ok || !pp.on() {
			continue
		}
		if restarts > 0 {
			k.failPart(p, version, "второе падение: "+why)
			continue
		}
		k.mu.Lock()
		p.restarts, p.err = 1, ""
		k.mu.Unlock()
		dir, err := k.install(pp)
		if err == nil {
			err = k.startPart(p, pp, dir)
		}
		if err != nil {
			k.failPart(p, pp.Version, "перезапуск: "+err.Error())
		}
	}
}

func (k *Keeper) failPart(p *part, version, why string) {
	k.mu.Lock()
	p.state, p.err, p.version = "failed", why, version
	k.mu.Unlock()
	k.j.stop("part_failed", p.name+" "+version+": "+why, "part", p.name, "version", version)
	k.ledger("part.failed", fmt.Sprintf("%s %s — %s", p.name, version, why))
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
	return a.Version == b.Version && a.Sha256 == b.Sha256 && a.on() == b.on() && a.Force == b.Force && sameEnv(a, b)
}

// sameEnv — окружение части в плане то же.
func sameEnv(a, b planPart) bool {
	ea, _ := json.Marshal(a.Env)
	eb, _ := json.Marshal(b.Env)
	return string(ea) == string(eb)
}
