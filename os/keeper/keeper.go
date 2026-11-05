package main

// Keeper — исполнитель плана машины. Один актор исполняет планы по одному: из ожидающих — с наибольшей rev; после плана поднимает части,
// которые вышли сами. Кадры relay, выходы процессов и «убей» по force меняют состояние под одним мьютексом и будят актора.
// plan.json — план, который исполняется; без связи keeper исполняет его.
import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Options — пределы; ноль — как в работе.
type Options struct {
	Stop       time.Duration // выход после «закрой ввод» и после «убей», setup версии, ответ нового файла keeper на version
	PlanWait   time.Duration // ответ «Выпусков» на вопрос о плане
	Ping       time.Duration // ping relay; нет pong к следующему — соединение мёртвое
	PauseFirst time.Duration // пауза перед новым подключением к relay, вдвое после каждой неудачи
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

// entry — запись части в плане машины v1.
type entry struct {
	Part    string            `json:"part"`
	Version string            `json:"version"`
	Sha256  string            `json:"sha256"`
	URL     string            `json:"url,omitempty"`
	On      *bool             `json:"on,omitempty"`
	Force   bool              `json:"force,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

func (e entry) on() bool { return e.On == nil || *e.On }

// same — делать нечего: та же версия, то же окружение, то же включение.
func (e entry) same(o entry) bool {
	if e.Version != o.Version || e.on() != o.on() || len(e.Env) != len(o.Env) {
		return false
	}
	for k, v := range e.Env {
		if o.Env[k] != v {
			return false
		}
	}
	return true
}

type plan struct {
	Rev   int     `json:"rev"`
	Parts []entry `json:"parts"`
}

// decodePlan — план v1 строго: чужое поле — отказ.
func decodePlan(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	return d.Decode(v)
}

type Keeper struct {
	home, key, machine string
	o                  Options
	c                  conf
	j                  *journal
	ctx                context.Context
	cancel             context.CancelFunc
	done               chan struct{}
	links              sync.WaitGroup // связь с relay и соединения с держателями
	wake               chan struct{}

	mu      sync.Mutex
	plan    plan  // исполняется
	next    *plan // ждёт: с наибольшей rev
	order   []string
	parts   map[string]*part
	self    *part // запись keeper: в keeper.state, только пока failed
	stopped bool
}

func newKeeper(home string, o Options) (*Keeper, error) {
	o.defaults()
	key, machine := machineKey(home)
	j := newJournal(home, machine)
	c, err := readConf(home)
	if err != nil {
		why := "keeper.json не прочитан: " + err.Error()
		j.add("keeper", "keeper", "stop", "keeper_start", "why", why)
		return nil, fmt.Errorf("%s", why)
	}
	ctx, cancel := context.WithCancel(context.Background())
	k := &Keeper{home: home, key: key, machine: machine, o: o, c: c, j: j, ctx: ctx, cancel: cancel, done: make(chan struct{}),
		wake: make(chan struct{}, 1), parts: map[string]*part{}}
	k.note("keeper_start", "keeper", version(), "pid", os.Getpid(), "os", osName())
	return k, nil
}

func (k *Keeper) note(ev string, kv ...any)  { k.j.add("keeper", "keeper", "note", ev, kv...) }
func (k *Keeper) fault(ev string, kv ...any) { k.j.add("keeper", "keeper", "stop", ev, kv...) }

// refuse — план не исполняется: слово и причина.
func (k *Keeper) refuse(word, why string) {
	k.j.add("keeper", "keeper", "refuse", "plan", "word", word, "why", why)
}

// Run — старт: прежние файлы keeper убраны, держатели подключены, сохранённый план исполняется, связь с relay.
func (k *Keeper) Run() {
	if me, err := k.o.Self(); err == nil {
		olds, _ := filepath.Glob(me + ".*.old")
		for _, f := range olds {
			os.Remove(f)
		}
	}
	saved, ok := k.savedPlan()
	if ok {
		k.next = &saved
	}
	k.links.Add(1)
	go k.link()
	go func() {
		k.adoptAll(saved)
		k.actor()
		k.mu.Lock()
		k.stopped = true
		hs := []*held{}
		for _, p := range k.parts {
			if p.h != nil {
				hs = append(hs, p.h)
			}
		}
		k.mu.Unlock()
		k.cancel()
		for _, h := range hs {
			h.c.Close() // держатели живут: процессы остаются у них
		}
		k.links.Wait()
		k.note("keeper_exit")
		close(k.done)
	}()
}

// Stop — штатная остановка: долгий шаг прерван, связь закрыта, процессы частей живут у держателей; keeper_exit — последняя строка.
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

// savedPlan — plan.json; нет или битый — пустой план, битый — строка с причиной.
func (k *Keeper) savedPlan() (plan, bool) {
	var p plan
	b, err := os.ReadFile(filepath.Join(k.home, "plan.json"))
	if err == nil {
		err = json.Unmarshal(b, &p)
	}
	if err != nil && !os.IsNotExist(err) {
		k.fault("plan", "why", "plan.json не прочитан, исполняю пустой план: "+err.Error())
	}
	return p, err == nil
}

// offer — план от «Выпусков»: старше исполняемого — отказ; та же rev или не новее ожидающего — делать нечего. «Убей» по force — сразу,
// мимо очереди.
func (k *Keeper) offer(p plan) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if p.Rev < k.plan.Rev {
		k.refuse("old_rev", fmt.Sprintf("план rev %d старше исполняемого rev %d", p.Rev, k.plan.Rev))
		return
	}
	if p.Rev == k.plan.Rev || k.next != nil && p.Rev <= k.next.Rev {
		return
	}
	k.next = &p
	for _, e := range p.Parts {
		if q := k.parts[e.Part]; q != nil && q.h != nil && e.Force && !e.on() {
			q.stopping = true
			q.h.kill()
		}
	}
	k.poke()
}

// actor — планы по одному, затем вышедшие сами; выход — остановка или подмена себя.
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
		k.restartExited()
		select {
		case <-k.ctx.Done():
		case <-k.wake:
		}
	}
}

// execute — план целиком: убранные части сняты, остальные по порядку, запись keeper — последним шагом. true — keeper подменил себя.
func (k *Keeper) execute(p plan) bool {
	b, _ := json.Marshal(p)
	writeFile(filepath.Join(k.home, "plan.json"), b)
	k.note("plan", "rev", p.Rev)
	var self *entry
	want := map[string]bool{}
	order := []string{}
	for i, e := range p.Parts {
		if e.Part == "keeper" {
			self = &p.Parts[i]
			continue
		}
		want[e.Part] = true
		order = append(order, e.Part)
	}
	k.mu.Lock()
	k.order = order
	var gone []*part
	for name, q := range k.parts {
		if !want[name] {
			gone = append(gone, q)
		}
	}
	k.mu.Unlock()
	for _, q := range gone {
		k.remove(q)
	}
	for _, e := range p.Parts {
		if k.ctx.Err() != nil {
			return false
		}
		if e.Part != "keeper" {
			k.apply(e)
		}
	}
	return k.ctx.Err() == nil && k.selfUpdate(self)
}

// planned — запись части в исполняемом плане.
func (k *Keeper) planned(name string) *entry {
	for i, e := range k.plan.Parts {
		if e.Part == name {
			return &k.plan.Parts[i]
		}
	}
	return nil
}

type partState struct {
	Part     string `json:"part"`
	Version  string `json:"version"`
	State    string `json:"state"`
	Pid      int    `json:"pid,omitempty"`
	Restarts int    `json:"restarts"`
	Error    string `json:"error,omitempty"`
}

// State — ответ keeper.state v1.
func (k *Keeper) State() map[string]any {
	k.mu.Lock()
	defer k.mu.Unlock()
	parts := []partState{}
	view := func(p *part) partState {
		return partState{Part: p.name, Version: p.version, State: p.state, Pid: p.pid, Restarts: p.restarts, Error: p.err}
	}
	for _, name := range k.order {
		if p := k.parts[name]; p != nil {
			parts = append(parts, view(p))
		}
	}
	if k.self != nil {
		parts = append(parts, view(k.self))
	}
	return map[string]any{"keeper": version(), "rev": k.plan.Rev, "os": osName(), "parts": parts}
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
