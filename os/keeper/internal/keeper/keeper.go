// Keeper исполняет план машины от «Выпусков»: ставит версии, держит части через держателей, отвечает keeper.state, подменяет себя. Сам ничего не решает.
//
// Все переходы частей делает один цикл: план, затем вышедшие сами. На долгом шаге цикл стоит, вышедшая тем временем часть ждёт его в exited.
package keeper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"sync"
	"time"

	"switchboard/keeper/internal/machine"
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
	for _, d := range []struct {
		v   *time.Duration
		def time.Duration
	}{{&o.StopLimit, time.Minute}, {&o.PlanWait, 30 * time.Second}, {&o.Ping, 30 * time.Second}, {&o.PauseFirst, time.Second},
		{&o.PauseMax, time.Minute}, {&o.Download, 10 * time.Minute}, {&o.HolderWait, 5 * time.Second}} {
		if *d.v == 0 {
			*d.v = d.def
		}
	}
	if o.Self == nil {
		o.Self = os.Executable
	}
}

// Entry — запись части в плане: версия раскрыта, ссылка на архив живёт час.
type Entry struct {
	Part    string            `json:"part"`
	Version string            `json:"version"`
	SHA256  string            `json:"sha256"`
	URL     string            `json:"url"`
	On      *bool             `json:"on,omitempty"`
	Force   bool              `json:"force,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

func (e Entry) off() bool { return e.On != nil && !*e.On }

// Plan — план машины v1; rev растёт.
type Plan struct {
	Rev   int     `json:"rev"`
	Parts []Entry `json:"parts"`
}

func (p *Plan) find(name string) *Entry {
	if p == nil {
		return nil
	}
	if i := slices.IndexFunc(p.Parts, func(e Entry) bool { return e.Part == name }); i >= 0 {
		return &p.Parts[i]
	}
	return nil
}

// PartState — часть в keeper.state v1.
type PartState struct {
	Part     string `json:"part"`
	Version  string `json:"version,omitempty"`
	State    string `json:"state"`
	Pid      int    `json:"pid,omitempty"`
	Restarts int    `json:"restarts"`
	Error    string `json:"error,omitempty"`
}

// State — ответ keeper.state.
type State struct {
	Keeper string      `json:"keeper"`
	Rev    int         `json:"rev"`
	OS     string      `json:"os"`
	Parts  []PartState `json:"parts"`
}

// Keeper — один на папку машины.
type Keeper struct {
	o         Options
	home      string
	j         *machine.Journal
	conf      machine.Conf
	key, name string
	bin       string // этот файл: им запускаются держатели
	ctx       context.Context
	cancel    context.CancelFunc
	wake      chan struct{} // пришёл план или часть вышла сама
	done      chan struct{}
	wg        sync.WaitGroup // чтение держателей, связь, строки журнала флота

	mu    sync.Mutex
	parts map[string]*part
	plan  *Plan // исполняемый
	next  *Plan // самый новый из ждущих цикла
}

func osName() string { return runtime.GOOS + " " + runtime.GOARCH }

// New — keeper на папке home; echo — копия строк журнала, может быть nil. keeper.json не прочитан — отказ и строка журнала: держатели не тронуты.
func New(home string, echo io.Writer, o Options) (*Keeper, error) {
	o.fill()
	j := machine.NewJournal(home, "keeper", echo)
	conf, err := machine.ReadConf(home)
	if err != nil {
		err = fmt.Errorf("keeper.json не прочитан: %w", err)
		j.Line("keeper", "stop", "keeper_start", "why", err.Error())
		return nil, err
	}
	bin, err := os.Executable()
	if err != nil {
		return nil, err
	}
	key := machine.Key(home)
	k := &Keeper{o: o, home: home, j: j, conf: conf, key: key, name: machine.NameOf(key), bin: bin,
		wake: make(chan struct{}, 1), done: make(chan struct{}), parts: map[string]*part{}}
	k.ctx, k.cancel = context.WithCancel(context.Background())
	return k, nil
}

// Run — запуск; конец — Done.
func (k *Keeper) Run() {
	k.note("keeper", "keeper_start", "keeper", k.o.Version, "pid", os.Getpid(), "os", osName())
	go k.loop(k.loadPlan())
}

// Stop — штатная остановка: нового не берёт, начатый setup доводит, связь закрыта с причиной; keeper_exit — последняя строка. Держатели и их процессы живут.
func (k *Keeper) Stop() {
	k.cancel()
	<-k.done
}

// Done — keeper закончил: остановлен или подменил себя.
func (k *Keeper) Done() <-chan struct{} { return k.done }

// State — keeper.state сейчас: только о частях своего плана.
func (k *Keeper) State() State {
	k.mu.Lock()
	defer k.mu.Unlock()
	s := State{Keeper: k.o.Version, OS: osName(), Parts: []PartState{}}
	if k.plan != nil {
		s.Rev = k.plan.Rev
	}
	for _, p := range k.parts {
		s.Parts = append(s.Parts, PartState{Part: p.name, Version: p.version, State: p.state, Pid: p.pid, Restarts: p.restarts, Error: p.err})
	}
	sort.Slice(s.Parts, func(i, j int) bool { return s.Parts[i].Part < s.Parts[j].Part })
	return s
}

func (k *Keeper) poke() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

func (k *Keeper) leaving() bool { return k.ctx.Err() != nil }

func (k *Keeper) note(part, ev string, kv ...any) { k.j.Line(part, "note", ev, kv...) }
func (k *Keeper) stopLine(part, ev, why string, kv ...any) {
	k.j.Line(part, "stop", ev, append([]any{"why", why}, kv...)...)
}
func (k *Keeper) refuse(word, why string) {
	k.j.Line("keeper", "refuse", "plan", "word", word, "why", why)
}

func (k *Keeper) loop(saved *Plan) {
	k.cleanOldSelf()
	k.adopt(saved)
	if saved != nil {
		k.offer(saved)
	}
	k.wg.Add(1)
	go k.linkLoop()
	for !k.leaving() {
		k.mu.Lock()
		pl := k.next
		k.next = nil
		k.mu.Unlock()
		switch {
		case pl != nil:
			k.execute(pl)
		case k.restartExited():
		default:
			select {
			case <-k.wake:
			case <-k.ctx.Done():
			}
		}
	}
	k.cancel()
	k.mu.Lock()
	for _, p := range k.parts {
		if p.proc != nil {
			p.proc.conn.Close()
		}
	}
	k.mu.Unlock()
	k.wg.Wait()
	k.note("keeper", "keeper_exit")
	close(k.done)
}

func (k *Keeper) loadPlan() *Plan {
	b, err := os.ReadFile(filepath.Join(k.home, "plan.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		k.stopLine("keeper", "plan", "plan.json не прочитан — план пустой до плана от «выпусков»: "+err.Error())
		return nil
	}
	var pl Plan
	if err := json.Unmarshal(b, &pl); err != nil {
		k.stopLine("keeper", "plan", "plan.json не разобран — план пустой до плана от «выпусков», держатели частей сняты как ничьи: "+err.Error())
		return nil
	}
	return &pl
}

// strict — разбор контракта v1: незнакомое поле — ошибка, замороженный keeper не исполняет того, чего не знает.
func strict(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	return d.Decode(v)
}

// offer — план пришёл: из ждущих берётся старший; тот же rev — переподключение; младше исполняемого — «Выпуски» потеряли счёт.
func (k *Keeper) offer(pl *Plan) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.next != nil && pl.Rev <= k.next.Rev {
		return
	}
	if k.plan != nil {
		if pl.Rev == k.plan.Rev {
			return
		}
		if pl.Rev < k.plan.Rev {
			k.refuse("old_rev", fmt.Sprintf("план rev %d старше исполняемого rev %d", pl.Rev, k.plan.Rev))
			return
		}
	}
	k.next = pl
	k.poke()
}

// execute — план целиком: записи, снять убранные, подмена себя — последним шагом. На диск — до первого шага: не успел — доведёт следующий keeper.
func (k *Keeper) execute(pl *Plan) {
	k.mu.Lock()
	k.plan = pl
	k.mu.Unlock()
	b, _ := json.MarshalIndent(pl, "", "  ")
	if err := machine.WriteAtomic(filepath.Join(k.home, "plan.json"), append(b, '\n')); err != nil {
		k.stopLine("keeper", "plan", "plan.json не записан — после перезапуска keeper исполнит прежний: "+err.Error())
	}
	k.note("keeper", "plan", "rev", pl.Rev, "parts", len(pl.Parts))
	for _, e := range pl.Parts {
		if k.leaving() {
			return
		}
		if e.Part != selfName {
			k.apply(e)
		}
	}
	k.mu.Lock()
	var gone []*part
	for name, p := range k.parts {
		if pl.find(name) == nil {
			gone = append(gone, p)
		}
	}
	k.mu.Unlock()
	for _, p := range gone {
		if k.leaving() {
			return
		}
		k.removePart(p)
	}
	if e := pl.find(selfName); e != nil && !k.leaving() {
		k.updateSelf(*e)
	}
}
