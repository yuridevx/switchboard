package keeper

import (
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"switchboard/keeper/internal/holder"
	"switchboard/keeper/internal/machine"
)

// Состояния части. exited — вышла сама и ждёт разбора, пока цикл занят планом.
const (
	running  = "running"
	stopping = "stopping"
	stopped  = "stopped"
	exited   = "exited"
	failed   = "failed"
)

// part — часть машины. Поля — под k.mu.
type part struct {
	name     string
	version  string
	env      map[string]string
	state    string
	pid      int
	restarts int
	err      string // сбой новой версии, причина failed или выхода
	proc     *proc
}

// proc — соединение с держателем нынешнего процесса части.
type proc struct {
	conn *holder.Conn
	done chan struct{} // процесс вышел или связь оборвалась
}

func (k *Keeper) partDir(name string) string { return filepath.Join(k.home, "parts", name) }

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

// adopt — держатели с прошлой жизни: есть в плане — подключиться, нет — убить. Держатели Host — не его.
func (k *Keeper) adopt(pl *Plan) {
	for _, f := range holder.Files(k.home) {
		if f.Owner != "keeper" {
			continue
		}
		c, hello, err := holder.Dial(f, k.o.HolderWait)
		if err != nil {
			k.note(f.ID, "adopt", "id", f.ID, "why", "держатель не отвечает — файл убран: "+err.Error())
			holder.Remove(k.home, f.ID)
			continue
		}
		e := pl.find(f.ID)
		if e == nil || f.ID == selfName {
			k.note(f.ID, "orphan_kill", "id", f.ID, "why", "части нет в плане")
			c.Kill()
			c.Limit(k.o.HolderWait)
			c.Read(func([]byte) {})
			c.Close()
			continue
		}
		var env map[string]string
		if f.Tag == e.Version {
			env = e.Env
		}
		k.note(f.ID, "adopt", "id", f.ID, "pid", hello.Pid, "version", f.Tag, "buffered", hello.Buffered)
		k.attach(k.slot(f.ID), c, hello.Pid, f.Tag, env)
	}
}

// attach — часть ведёт этот держатель: читать его кадры до выхода процесса.
func (k *Keeper) attach(p *part, c *holder.Conn, pid int, version string, env map[string]string) {
	h := &proc{conn: c, done: make(chan struct{})}
	k.mu.Lock()
	p.proc, p.pid, p.version, p.env, p.state = h, pid, version, env, running
	k.mu.Unlock()
	k.wg.Add(1)
	go k.follow(p, h)
}

// follow — вывод части строками в журнал; выход отмечается в состоянии, решает цикл.
func (k *Keeper) follow(p *part, h *proc) {
	defer k.wg.Done()
	defer close(h.done)
	lines := machine.Lines{Emit: func(l string) { k.note(p.name, "out", "line", l) }}
	x, err := h.conn.Read(func(b []byte) { lines.Write(b) })
	h.conn.Close()
	if x == nil && k.leaving() {
		return // keeper останавливается: держатель живёт дальше
	}
	if x == nil {
		x = &holder.Exit{Stderr: "связь с держателем оборвалась: " + err.Error()}
	} else {
		lines.Flush()
	}
	why := exitWords(x)
	k.mu.Lock()
	defer k.mu.Unlock()
	if p.proc != h {
		return
	}
	p.proc, p.pid = nil, 0
	// ОС останавливается раньше, чем об этом узнаёт служба keeper (win11-2 1 нояб.: держатель на 5 с раньше): такой выход — не падение
	if p.state == stopping || x.OSStop {
		k.note(p.name, "part_exit", "version", p.version, "why", why)
		p.state = stopped
	} else {
		k.stopLine(p.name, "part_exit", fmt.Sprintf("%s %s вышла сама: %s", p.name, p.version, why), "version", p.version)
		p.state, p.err = exited, why
	}
	k.poke()
}

func exitWords(x *holder.Exit) string {
	var w []string
	if x.Signal != nil {
		w = append(w, "сигнал "+*x.Signal)
	} else if x.Code != nil {
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

// apply — запись плана: выключить или привести часть к этой версии и окружению. Версия годна раньше, чем остановлена прежняя.
func (k *Keeper) apply(e Entry) {
	p := k.slot(e.Part)
	k.mu.Lock()
	alive, was := p.state == running, p.version
	same := was == e.Version && maps.Equal(p.env, e.Env)
	// вышедшую сама цикл разберёт сразу после плана; failed остаётся failed, пока запись не поменялась: решает тот, кто правит план
	done := p.state == exited || (p.state == failed && same && !e.off()) || (alive && same && !e.off())
	if alive && same && !e.off() {
		p.err = ""
	}
	k.mu.Unlock()
	if done {
		return
	}
	if e.off() {
		if !k.stopPart(p, e.Force) {
			return
		}
		k.mu.Lock()
		p.state, p.restarts, p.err = stopped, 0, ""
		k.mu.Unlock()
		return
	}
	a, err := k.install(e)
	if k.leaving() {
		return // работающая версия живёт дальше, переход — у следующего keeper
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
		k.stopLine(e.Part, "install", err.Error(), "version", e.Version)
		k.ledger("part.failed", fmt.Sprintf("%s %s — %s", e.Part, e.Version, err))
		return
	}
	if !k.stopPart(p, false) || k.leaving() {
		return
	}
	k.mu.Lock()
	p.restarts, p.err = 0, ""
	k.mu.Unlock()
	if err := k.launch(p, e, a); err != nil {
		k.fail(p, e.Version, err.Error())
		return
	}
	if alive && was != e.Version {
		k.note(e.Part, "part_updated", "from", was, "to", e.Version)
		k.ledger("part.updated", fmt.Sprintf("%s %s → %s", e.Part, was, e.Version))
	}
	k.dropVersions(e.Part, e.Version, was)
}

// fail — часть failed: дальше решает тот, кто правит план.
func (k *Keeper) fail(p *part, version, why string) {
	k.mu.Lock()
	p.state, p.err, p.version, p.pid = failed, why, version, 0
	k.mu.Unlock()
	k.stopLine(p.name, "part_failed", p.name+" "+version+": "+why, "version", version)
	k.ledger("part.failed", fmt.Sprintf("%s %s — %s", p.name, version, why))
}

// launch — держатель с командой из app.json; рабочая папка — data части.
func (k *Keeper) launch(p *part, e Entry, a app) error {
	data := filepath.Join(k.partDir(e.Part), "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		return fmt.Errorf("запуск: %w", err)
	}
	f, err := holder.Spawn(holder.Spec{Bin: k.bin, ID: e.Part, Owner: "keeper", Tag: e.Version, Cwd: data, Detach: a.DetachChildren,
		Env: k.partEnv(e, data), Cmd: k.command(filepath.Join(k.partDir(e.Part), e.Version), a.Run)}, k.o.HolderWait)
	if err != nil {
		return fmt.Errorf("запуск: %w", err)
	}
	c, hello, err := holder.Dial(f, k.o.HolderWait)
	if err != nil {
		return fmt.Errorf("запуск: %w", err)
	}
	k.attach(p, c, hello.Pid, e.Version, e.Env)
	k.note(e.Part, "part_start", "version", e.Version, "pid", hello.Pid)
	return nil
}

// partEnv — окружение части: окружение машины и из плана.
func (k *Keeper) partEnv(e Entry, data string) []string {
	env := append(os.Environ(), "SWITCHBOARD_MACHINE="+k.name, "SWITCHBOARD_VERSION="+e.Version, "SWITCHBOARD_DATA="+data, "SWITCHBOARD_HOME="+k.home, "SWITCHBOARD_HOLDER="+k.bin)
	if len(k.conf.Workers) > 0 {
		env = append(env, "SWITCHBOARD_WORKERS="+string(must(k.conf.Workers)))
	}
	for name, v := range e.Env {
		env = append(env, name+"="+v)
	}
	return env
}

// stopPart — снять работающий процесс и дождаться выхода: закрытый ввод, предел, «убей», предел. false — не снят: keeper уходит или часть не вышла
// и после «убей», тогда она failed — две версии разом нельзя.
func (k *Keeper) stopPart(p *part, force bool) bool {
	k.mu.Lock()
	if p.state != running {
		k.mu.Unlock()
		return true
	}
	p.state = stopping
	h, version := p.proc, p.version
	k.mu.Unlock()
	if !force {
		h.conn.CloseInput()
		switch k.waitExit(h, func() bool { return k.forced(p.name) }) {
		case waitDone:
			return true
		case waitLeaving:
			return false
		case waitLate:
			k.stopLine(p.name, "stop_late", fmt.Sprintf("%s %s не вышла за %v после «закрой ввод» — держатель убивает дерево", p.name, version, k.o.StopLimit))
		case waitForced:
			k.note(p.name, "force")
		}
	}
	h.conn.Kill()
	switch k.waitExit(h, nil) {
	case waitDone:
		return true
	case waitLeaving:
		return false
	}
	k.stopLine(p.name, "stop_late", fmt.Sprintf("%s %s не вышла и за %v после «убей»", p.name, version, k.o.StopLimit))
	k.mu.Lock()
	p.proc = nil
	k.mu.Unlock()
	h.conn.Close()
	k.fail(p, version, "не вышла после «убей»")
	return false
}

type waitResult int

const (
	waitDone waitResult = iota
	waitLeaving
	waitLate
	waitForced
)

// waitExit — выход процесса не дольше предела; остановка keeper прерывает ожидание; force — новый план велит не ждать.
func (k *Keeper) waitExit(h *proc, force func() bool) waitResult {
	t := time.NewTimer(k.o.StopLimit)
	defer t.Stop()
	for {
		select {
		case <-h.done:
			return waitDone
		case <-k.ctx.Done():
			return waitLeaving
		case <-t.C:
			return waitLate
		case <-k.wake:
			if force != nil && force() {
				return waitForced
			}
		}
	}
}

// forced — в ждущем плане у этой части «выключить силой».
func (k *Keeper) forced(name string) bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	e := k.next.find(name)
	return e != nil && e.Force && e.off()
}

// removePart — части нет в плане: снята, папки версий убраны, data/ осталась.
func (k *Keeper) removePart(p *part) {
	if !k.stopPart(p, false) {
		return
	}
	k.mu.Lock()
	delete(k.parts, p.name)
	k.mu.Unlock()
	if p.name != selfName {
		k.dropVersions(p.name)
		k.note(p.name, "part_removed")
	}
}

// dropVersions — папки версий, кроме keep; занятую ОС не даёт удалить — остаётся до следующей.
func (k *Keeper) dropVersions(name string, keep ...string) {
	es, _ := os.ReadDir(k.partDir(name))
	for _, e := range es {
		if !e.IsDir() || e.Name() == "data" || slices.Contains(keep, e.Name()) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(k.partDir(name), e.Name())); err != nil {
			k.note(name, "cleanup", "version", e.Name(), "why", "занята: "+err.Error())
		}
	}
}

// restartExited — вышедшие сами, по нынешнему плану: нет в плане или выключена — stopped; один перезапуск; второй раз — failed. true — что-то сделано.
func (k *Keeper) restartExited() bool {
	k.mu.Lock()
	var names []string
	for name, p := range k.parts {
		if p.state == exited {
			names = append(names, name)
		}
	}
	k.mu.Unlock()
	sort.Strings(names)
	for _, name := range names {
		if !k.leaving() {
			k.restart(k.slot(name), name)
		}
	}
	return len(names) > 0
}

func (k *Keeper) restart(p *part, name string) {
	k.mu.Lock()
	e := k.plan.find(name)
	if e == nil || e.off() {
		p.state, p.err = stopped, ""
		k.mu.Unlock()
		return
	}
	second, why, version := p.restarts > 0, p.err, p.version
	if !second {
		p.restarts, p.err = 1, ""
	}
	k.mu.Unlock()
	if second {
		k.fail(p, version, "второе падение: "+why)
		return
	}
	a, err := k.install(*e)
	if err == nil && !k.leaving() {
		err = k.launch(p, *e, a)
	}
	if err != nil && !k.leaving() {
		k.fail(p, e.Version, "перезапуск: "+err.Error())
	}
}
