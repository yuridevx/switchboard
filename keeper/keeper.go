package main

// Keeper — исполнитель плана машины. План — ответ флота на builds.plan: сборка Host и файл Keeper. Один актор исполняет планы по одному и
// поднимает Host, который вышел сам. Кадры флота и выход процесса меняют состояние под одним мьютексом и будят актора.
// plan.json — план, который исполняется; без связи Keeper исполняет его с диска.
import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// Options — пределы; ноль — как в работе.
type Options struct {
	Stop       time.Duration // выход Host после «закрой ввод» и после «убей», npm ci сборки, ответ нового файла keeper на version
	PlanWait   time.Duration // ответ флота на вопрос о плане
	Ping       time.Duration // ping соединения; нет ответа к следующему — соединение мёртвое
	PauseFirst time.Duration // пауза перед новым подключением, вдвое после каждой неудачи
	PauseMax   time.Duration
	Download   time.Duration
	HolderWait time.Duration // строка держателя о себе
	Self       func() (string, error)
}

func (o *Options) defaults() {
	for _, d := range []struct {
		v   *time.Duration
		def time.Duration
	}{{&o.Stop, time.Minute}, {&o.PlanWait, 30 * time.Second}, {&o.Ping, 30 * time.Second},
		{&o.PauseFirst, time.Second}, {&o.PauseMax, time.Minute}, {&o.Download, 10 * time.Minute}, {&o.HolderWait, 30 * time.Second}} {
		if *d.v == 0 {
			*d.v = d.def
		}
	}
	if o.Self == nil {
		o.Self = os.Executable
	}
}

// planFile — файл сборки: ссылка живёт час, sha256 — содержимого.
type planFile struct {
	URL    string `json:"url"`
	Sha256 string `json:"sha256"`
}

// plan — план машины: одна сборка, архив Host и файл Keeper.
type plan struct {
	Build  int      `json:"build"`
	Host   planFile `json:"host"`
	Keeper planFile `json:"keeper"`
}

// host — Host глазами Keeper.
type host struct {
	build    int    // сборка, с которой работает или работал процесс
	want     int    // сборка последнего исполненного плана
	state    string // running | stopping | stopped | exited | failed
	updating bool   // идёт смена сборки
	restarts int
	why      string // причина сбоя или последнего выхода
	since    time.Time
	h        *held
	pid      int
	stopping bool // остановка запрошена: выход — не падение
}

type Keeper struct {
	home, key, fleet, machine string
	o                         Options
	c                         conf
	j                         *journal
	ctx                       context.Context
	cancel                    context.CancelFunc
	done                      chan struct{}
	links                     sync.WaitGroup // связь с флотом и запросы к нему
	wake                      chan struct{}
	barred                    chan struct{} // закрыт: пропуск не принят — связи больше нет
	barOnce                   sync.Once
	selfSha                   string

	mu      sync.Mutex
	plan    plan  // исполняется
	next    *plan // ждёт
	host    host
	stopped bool
	restart bool // запрошен перезапуск Host той же сборки
}

func newKeeper(home string, o Options) (*Keeper, error) {
	o.defaults()
	key, fleet := machineKey(home)
	c, err := readConf(home)
	j := newJournal(home, fleet, c.Machine)
	if err != nil {
		why := "keeper.json не прочитан: " + err.Error()
		j.add("keeper", "error", "keeper_start", "why", why)
		return nil, fmt.Errorf("%s", why)
	}
	ctx, cancel := context.WithCancel(context.Background())
	k := &Keeper{home: home, key: key, fleet: fleet, machine: c.Machine, o: o, c: c, j: j, ctx: ctx, cancel: cancel, done: make(chan struct{}),
		wake: make(chan struct{}, 1), barred: make(chan struct{}), host: host{state: "stopped", since: time.Now()}}
	k.note("keeper_start", "build", buildNumber(), "pid", os.Getpid(), "os", osName())
	return k, nil
}

func (k *Keeper) note(msg string, kv ...any)  { k.j.add("keeper", "info", msg, kv...) }
func (k *Keeper) warn(msg string, kv ...any)  { k.j.add("keeper", "warn", msg, kv...) }
func (k *Keeper) fault(msg string, kv ...any) { k.j.add("keeper", "error", msg, kv...) }

// Run — старт: прежние файлы keeper убраны, держатель Host подключён, сохранённый план исполняется, связь с флотом.
func (k *Keeper) Run() {
	if me, err := k.o.Self(); err == nil {
		olds, _ := filepath.Glob(me + ".*.old")
		for _, f := range olds {
			os.Remove(f)
		}
		k.selfSha, _ = fileSha(me)
	}
	saved, ok := k.savedPlan()
	if ok {
		k.next = &saved
	}
	k.links.Add(1)
	go k.link()
	go func() {
		k.adopt()
		k.actor()
		k.mu.Lock()
		k.stopped = true
		h := k.host.h
		k.mu.Unlock()
		k.cancel()
		if h != nil {
			h.c.Close() // держатель живёт: Host остаётся у него
		}
		k.links.Wait()
		k.note("keeper_exit")
		close(k.done)
	}()
}

// Stop — штатная остановка: долгий шаг прерван, связь закрыта, Host и сессии живут у держателей; keeper_exit — последняя строка.
func (k *Keeper) Stop() {
	k.cancel()
	<-k.done
}

func (k *Keeper) Done() <-chan struct{} { return k.done }

func (k *Keeper) poke() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

// locked — f под мьютексом состояния.
func (k *Keeper) locked(f func()) {
	k.mu.Lock()
	f()
	k.mu.Unlock()
}

// savedPlan — plan.json; нет — плана нет; битый — строка с причиной, плана нет.
func (k *Keeper) savedPlan() (plan, bool) {
	var p plan
	b, err := os.ReadFile(filepath.Join(k.home, "plan.json"))
	if err == nil {
		err = json.Unmarshal(b, &p)
	}
	if err != nil && !os.IsNotExist(err) {
		k.fault("plan", "why", "plan.json не прочитан — жду план флота: "+err.Error())
	}
	return p, err == nil && p.Build > 0
}

// offer — план от флота: встаёт в очередь; ожидавший заменяется — исполняется последний.
func (k *Keeper) offer(p plan) {
	k.mu.Lock()
	k.next = &p
	k.mu.Unlock()
	k.poke()
}

// actor — планы по одному, затем Host, вышедший сам; выход — остановка или подмена себя.
func (k *Keeper) actor() {
	for k.ctx.Err() == nil {
		k.mu.Lock()
		p := k.next
		k.next = nil
		if p != nil {
			k.plan = *p
		}
		k.mu.Unlock()
		if p != nil {
			if k.execute(*p) {
				return
			}
			continue
		}
		k.restartAsked()
		k.restartExited()
		select {
		case <-k.ctx.Done():
		case <-k.wake:
		}
	}
}

// execute — план целиком: Host, затем подмена себя — последним шагом. true — keeper подменил себя.
func (k *Keeper) execute(p plan) bool {
	b, _ := json.Marshal(p)
	if err := writeFile(filepath.Join(k.home, "plan.json"), b); err != nil {
		k.fault("plan", "why", "plan.json не записан — после перезапуска keeper исполнит прежний: "+err.Error())
	}
	k.note("plan", "build", p.Build)
	k.applyHost(p)
	return k.ctx.Err() == nil && k.selfUpdate(p)
}

func (k *Keeper) hostDir() string { return filepath.Join(k.home, "host") }

// applyHost — сборка Host из плана: работает с ней — делать нечего; иначе поставить, остановить прежний, запустить новый.
func (k *Keeper) applyHost(p plan) {
	k.mu.Lock()
	h := &k.host
	same := h.state != "stopped" && h.want == p.Build // вышел сам или failed с той же сборкой — решают перезапуск и новый план
	if h.state == "running" {                        // сверка — с работающим процессом: сборка, которая не встала, пробуется снова
		if same = h.build == p.Build; same {
			h.why = ""
		}
	}
	h.want = p.Build
	if !same {
		h.updating = true
	}
	k.mu.Unlock()
	if same {
		return
	}
	defer k.locked(func() { k.host.updating = false })
	dir, err := k.installHost(p)
	if k.ctx.Err() != nil {
		return
	}
	if err != nil {
		k.failHost(p.Build, err.Error())
		return
	}
	old := h.build
	if k.stopHost() != nil {
		return
	}
	if err := k.startHost(p.Build, dir, false); err != nil {
		if k.ctx.Err() == nil {
			k.failHost(p.Build, err.Error())
		}
		return
	}
	if old != 0 && old != p.Build {
		k.note("host_updated", "from", old, "to", p.Build)
		k.ledger("host.updated", fmt.Sprintf("Host %d → %d", old, p.Build), map[string]any{"from": old, "to": p.Build})
	}
	k.prune(strconv.Itoa(p.Build), strconv.Itoa(old))
}

// failHost — сбой Host: работающая сборка работает дальше с причиной, иначе failed; строка в журнале машины и в журнале флота.
func (k *Keeper) failHost(build int, why string) {
	k.locked(func() {
		k.host.why = why
		if k.host.h == nil {
			k.host.state, k.host.build, k.host.since = "failed", build, time.Now()
		}
	})
	k.fault("host_failed", "build", build, "why", why)
	k.ledger("host.failed", fmt.Sprintf("Host %d — %s", build, why), map[string]any{"build": build})
}

// wait — держатель отдал выход за предел; false — не отдал или keeper останавливается.
func (k *Keeper) wait(h *held) bool {
	select {
	case <-h.done:
		return true
	case <-time.After(k.o.Stop):
	case <-k.ctx.Done():
	}
	return false
}

var errStuck = fmt.Errorf("Host не вышел")

// stopHost — выход процесса Host: закрыть ввод, не вышел за предел — убить, не вышел и тогда — failed.
func (k *Keeper) stopHost() error {
	k.mu.Lock()
	h := k.host.h
	if h != nil {
		k.host.stopping, k.host.state = true, "stopping"
	}
	build := k.host.build
	k.mu.Unlock()
	if h == nil {
		return nil
	}
	h.closeInput()
	if k.wait(h) {
		return nil
	}
	if k.ctx.Err() != nil {
		return k.ctx.Err()
	}
	k.fault("stop_late", "why", fmt.Sprintf("Host %d не вышел за %v после «закрой ввод» — держатель убивает процесс", build, k.o.Stop))
	h.kill()
	if k.wait(h) {
		return nil
	}
	if k.ctx.Err() != nil {
		return k.ctx.Err()
	}
	k.locked(func() { k.host.h, k.host.pid = nil, 0 })
	k.failHost(build, fmt.Sprintf("Host %d не вышел и за %v после «убей»", build, k.o.Stop))
	return errStuck
}

// startHost — процесс Host под новым держателем: node src/main.ts сборки, рабочая папка — данные Host. Потомки отпущены: держатели сессий
// переживают и Host, и его держателя.
func (k *Keeper) startHost(build int, dir string, restart bool) error {
	data := filepath.Join(k.hostDir(), "data")
	os.MkdirAll(data, 0o700)
	me, _ := os.Executable()
	env := append(os.Environ(), "SB_HOME="+k.home, "SB_FLEET="+k.fleet, "SB_MACHINE="+k.machine, "SB_BASE="+k.c.Base,
		"SB_BUILD="+strconv.Itoa(build), "SB_DATA="+data, "SB_HOLDER="+me)
	args := []string{"--id", "host", "--owner", "keeper", "--tag", strconv.Itoa(build), "--cwd", data, "--detach-children", "--",
		k.node(), filepath.Join(dir, "src", "main.ts")}
	about, err := spawnHolder(args, env, k.o.HolderWait)
	if err != nil {
		return fmt.Errorf("запуск: %w", err)
	}
	h, err := attach(about.Port, about.Key)
	if err != nil {
		return fmt.Errorf("запуск: %w", err)
	}
	k.locked(func() {
		x := &k.host
		x.h, x.pid, x.build, x.state, x.why, x.stopping, x.since = h, h.pid, build, "running", "", false, time.Now()
		if restart {
			x.restarts++
		} else {
			x.restarts = 0
		}
	})
	h.watch(func(h *held) { k.exited(h) })
	k.note("host_start", "build", build, "pid", h.pid)
	return nil
}

// exited — процесс Host вышел или связь с держателем оборвалась: по запросу или по остановке ОС — stopped, иначе — падение.
func (k *Keeper) exited(h *held) {
	k.mu.Lock()
	defer k.mu.Unlock()
	x := &k.host
	if k.stopped || x.h != h {
		return
	}
	x.h, x.pid, x.since = nil, 0, time.Now()
	why := h.why()
	switch {
	case x.stopping, h.exit != nil && h.exit.OSStop:
		x.state = "stopped"
		k.note("host_exit", "build", x.build, "why", why)
	default:
		x.state, x.why = "exited", why
		k.fault("host_exit", "build", x.build, "why", fmt.Sprintf("Host %d вышел сам: %s", x.build, why))
	}
	k.poke()
}

// restartExited — Host вышел сам: первое падение — перезапуск с диска, второе — failed.
func (k *Keeper) restartExited() {
	k.mu.Lock()
	x := k.host
	k.mu.Unlock()
	if x.state != "exited" || k.ctx.Err() != nil {
		return
	}
	if x.restarts > 0 {
		k.failHost(x.build, "второе падение: "+x.why)
		return
	}
	dir, err := k.installed(x.build)
	if err == nil {
		err = k.startHost(x.build, dir, true)
	}
	if err != nil && k.ctx.Err() == nil {
		k.failHost(x.build, "перезапуск: "+err.Error())
	}
}

// askRestart — запрос host.restart: исполняет актор, чтобы не пересечься с планом.
func (k *Keeper) askRestart() {
	k.locked(func() { k.restart = true })
	k.poke()
}

// restartAsked — перезапуск Host по запросу: остановить и запустить ту же сборку; упавший Host поднимается так же. Сессии живут в своих держателях.
func (k *Keeper) restartAsked() {
	k.mu.Lock()
	asked, x := k.restart, k.host
	k.restart = false
	k.mu.Unlock()
	if !asked || k.ctx.Err() != nil {
		return
	}
	build := x.build
	if build == 0 {
		build = x.want
	}
	dir, err := k.installed(build)
	if err != nil {
		k.failHost(build, "перезапуск: "+err.Error())
		return
	}
	if k.stopHost() != nil {
		return
	}
	if err := k.startHost(build, dir, false); err != nil {
		if k.ctx.Err() == nil {
			k.failHost(build, "перезапуск: "+err.Error())
		}
		return
	}
	k.note("host_restart", "build", build)
	k.ledger("host.restarted", fmt.Sprintf("Host %d перезапущен по запросу", build), map[string]any{"build": build})
}

// adopt — держатель Host на старте: подключиться; держатели сессий (owner host) Keeper не трогает.
func (k *Keeper) adopt() {
	file := filepath.Join(k.home, "procs", "host.json")
	var f struct {
		Owner, Key, Tag string
		Port            int
	}
	if b, err := os.ReadFile(file); err != nil || json.Unmarshal(b, &f) != nil || f.Owner != "keeper" {
		return
	}
	h, err := attach(f.Port, f.Key)
	if err != nil {
		os.Remove(file)
		k.fault("adopt", "why", "держатель Host не отвечает — файл убран: "+err.Error())
		return
	}
	build, _ := strconv.Atoi(f.Tag)
	k.locked(func() {
		k.host = host{build: build, want: build, state: "running", h: h, pid: h.pid, since: time.Now()}
	})
	h.watch(func(h *held) { k.exited(h) })
	k.note("adopt", "pid", h.pid, "build", build, "buffered", h.buffered)
}

// State — ответ keeper.state: сборка Keeper, сборка и состояние Host, ОС.
func (k *Keeper) State() map[string]any {
	k.mu.Lock()
	defer k.mu.Unlock()
	x := k.host
	state := "stopped"
	switch {
	case x.updating:
		state = "updating"
	case x.state == "running" || x.state == "failed":
		state = x.state
	}
	hs := map[string]any{"build": x.build, "state": state, "since": x.since.UnixMilli()}
	if x.pid != 0 {
		hs["pid"] = x.pid
	}
	if x.why != "" {
		hs["why"] = x.why
	}
	// plan — сборка последнего исполненного плана: расходится с host.build, пока новая сборка ставится или не встала
	return map[string]any{"build": buildNumber(), "host": hs, "os": osName(), "plan": x.want, "pid": os.Getpid()}
}
