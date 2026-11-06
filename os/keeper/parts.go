package main

// Часть машины: поставить запись плана, остановить, перезапустить после падения, снять; на старте — подключиться к своим держателям.
// Одно падение — один перезапуск с диска, второе — failed; failed снимает правка записи или перезапуск keeper.
import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type part struct {
	name     string
	run      entry  // запись, с которой работает или работал процесс
	want     *entry // последняя исполненная запись плана
	version  string
	state    string // running | stopping | stopped | exited | failed
	restarts int
	err      string
	why      string // причина последнего выхода
	h        *held
	pid      int
	stopping bool // остановка запрошена: выход — не падение
}

var errStuck = errors.New("часть не вышла")

func (k *Keeper) partDir(name string) string { return filepath.Join(k.home, "parts", name) }

// apply — запись части из плана.
func (k *Keeper) apply(e entry) {
	k.mu.Lock()
	p := k.parts[e.Part]
	if p == nil {
		p = &part{name: e.Part, state: "stopped", version: e.Version}
		k.parts[e.Part] = p
	}
	same := p.want != nil && p.want.same(e)
	if p.state == "running" { // запись сверяется с работающим процессом: откат на него его не трогает, версия, которая не встала, пробуется снова
		if same = p.run.same(e); same {
			p.err = ""
		}
	}
	p.want = &e
	k.mu.Unlock()
	if !e.on() {
		if k.stop(p, e.Force) == nil {
			k.locked(func() { p.state, p.err, p.version, p.restarts = "stopped", "", e.Version, 0 })
		}
		return
	}
	if same {
		return // работает, останавливается, вышла сама или failed с той же записью — решают перезапуск и правка плана
	}
	dir, a, err := k.install(e, true)
	if k.ctx.Err() != nil {
		return
	}
	if err != nil {
		k.fail(p, e.Version, err.Error())
		return
	}
	old := p.run.Version
	if k.stop(p, false) != nil {
		return
	}
	if err := k.start(p, e, dir, a, false); err != nil {
		if k.ctx.Err() == nil {
			k.fail(p, e.Version, err.Error())
		}
		return
	}
	if old != "" && old != e.Version {
		k.j.add("keeper", e.Part, "note", "part_updated", "from", old, "to", e.Version)
		k.ledger("part.updated", fmt.Sprintf("%s %s → %s", e.Part, old, e.Version))
	}
	k.prune(e.Part, e.Version, old)
}

// locked — f под мьютексом состояния.
func (k *Keeper) locked(f func()) {
	k.mu.Lock()
	f()
	k.mu.Unlock()
}

// fail — сбой части: работающая версия работает дальше с ошибкой, иначе failed; строка в журнале машины и в журнале флота.
func (k *Keeper) fail(p *part, ver, why string) {
	k.locked(func() {
		p.err = why
		if p.h == nil {
			p.state, p.version = "failed", ver
		}
	})
	k.j.add("keeper", p.name, "stop", "part_failed", "why", fmt.Sprintf("%s %s: %s", p.name, ver, why))
	k.ledger("part.failed", fmt.Sprintf("%s %s — %s", p.name, ver, why))
}

// stop — выход процесса: закрыть ввод (force — сразу убить), не вышла за предел — убить, не вышла и тогда — failed.
func (k *Keeper) stop(p *part, force bool) error {
	k.mu.Lock()
	h := p.h
	if h != nil {
		p.stopping, p.state = true, "stopping"
	}
	k.mu.Unlock()
	if h == nil {
		return nil
	}
	if force {
		h.kill()
	} else {
		h.closeInput()
	}
	if k.wait(h) {
		return nil
	}
	if k.ctx.Err() != nil {
		return k.ctx.Err()
	}
	if !force {
		k.j.add("keeper", p.name, "stop", "stop_late", "why", fmt.Sprintf("%s %s не вышла за %v после «закрой ввод» — держатель убивает дерево", p.name, p.version, k.o.Stop))
		h.kill()
		if k.wait(h) {
			return nil
		}
		if k.ctx.Err() != nil {
			return k.ctx.Err()
		}
	}
	why := fmt.Sprintf("%s %s не вышла и за %v после «убей»", p.name, p.version, k.o.Stop)
	k.j.add("keeper", p.name, "stop", "stop_late", "why", why)
	k.locked(func() { p.h, p.pid = nil, 0 })
	k.fail(p, p.version, why)
	return errStuck
}

// start — процесс части под новым держателем: окружение машины и плана, рабочая папка — data части.
func (k *Keeper) start(p *part, e entry, dir string, a app, restart bool) error {
	data := filepath.Join(k.partDir(e.Part), "data")
	os.MkdirAll(data, 0o700)
	me, _ := os.Executable()
	workers, _ := json.Marshal(k.c.Workers)
	env := append(os.Environ(), "SWITCHBOARD_MACHINE="+k.machine, "SWITCHBOARD_VERSION="+e.Version, "SWITCHBOARD_DATA="+data,
		"SWITCHBOARD_HOME="+k.home, "SWITCHBOARD_HOLDER="+me, "SWITCHBOARD_WORKERS="+string(workers))
	for n, v := range e.Env {
		env = append(env, n+"="+v)
	}
	args := []string{"--id", e.Part, "--owner", "keeper", "--tag", e.Version, "--cwd", data}
	if a.Detach {
		args = append(args, "--detach-children")
	}
	about, err := spawnHolder(append(append(args, "--"), k.resolve(a.Run, dir)...), env, k.o.HolderWait)
	if err != nil {
		return fmt.Errorf("запуск: %w", err)
	}
	h, err := attach(about.Port, about.Key)
	if err != nil {
		return fmt.Errorf("запуск: %w", err)
	}
	k.locked(func() {
		p.h, p.pid, p.run, p.version, p.state, p.err, p.stopping = h, h.pid, e, e.Version, "running", "", false
		if restart {
			p.restarts++
		} else {
			p.restarts = 0
		}
	})
	h.watch(func(h *held) { k.exited(p, h) })
	k.j.add("keeper", e.Part, "note", "part_start", "version", e.Version, "pid", h.pid)
	return nil
}

// exited — процесс части вышел или связь с держателем оборвалась: по запросу или по остановке ОС — stopped, иначе — падение.
func (k *Keeper) exited(p *part, h *held) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.stopped || p.h != h {
		return
	}
	p.h, p.pid, p.why = nil, 0, h.why()
	switch {
	case p.stopping:
		p.state = "stopped"
		k.j.add("keeper", p.name, "note", "part_exit", "version", p.version, "why", p.why)
	case h.exit != nil && h.exit.OSStop:
		p.state = "stopped"
		k.j.add("keeper", p.name, "note", "part_exit", "version", p.version, "why", p.why)
	default:
		p.state, p.err = "exited", p.why
		k.j.add("keeper", p.name, "stop", "part_exit", "version", p.version, "why", fmt.Sprintf("%s %s вышла сама: %s", p.name, p.version, p.why))
	}
	k.poke()
}

// restartExited — вышедшие сами: выключенная или убранная — stopped, первое падение — перезапуск с диска, второе — failed.
func (k *Keeper) restartExited() {
	k.mu.Lock()
	var todo []*part
	for _, name := range k.order {
		p := k.parts[name]
		if p == nil || p.state != "exited" {
			continue
		}
		if e := k.planned(name); e == nil || !e.on() {
			p.state, p.err = "stopped", ""
			continue
		}
		todo = append(todo, p)
	}
	k.mu.Unlock()
	for _, p := range todo {
		if k.ctx.Err() != nil {
			return
		}
		if p.restarts > 0 {
			k.fail(p, p.version, "второе падение: "+p.why)
			continue
		}
		dir, a, err := k.install(p.run, true)
		if k.ctx.Err() != nil {
			return
		}
		if err == nil {
			err = k.start(p, p.run, dir, a, true)
		}
		if err != nil {
			k.fail(p, p.version, "перезапуск: "+err.Error())
		}
	}
}

// remove — часть убрана из плана: остановлена, снята из keeper.state, папки версий убраны, data/ остаётся.
func (k *Keeper) remove(p *part) {
	if k.stop(p, false) != nil {
		return
	}
	k.locked(func() { delete(k.parts, p.name) })
	k.j.add("keeper", p.name, "note", "part_removed")
	k.prune(p.name)
}

// prune — папки версий части, кроме keep и data.
func (k *Keeper) prune(name string, keep ...string) {
	es, _ := os.ReadDir(k.partDir(name))
	for _, d := range es {
		if d.Name() != "data" && !contains(keep, d.Name()) {
			os.RemoveAll(filepath.Join(k.partDir(name), d.Name()))
		}
	}
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// adoptAll — держатели частей на старте: часть в плане — подключиться, нет в плане — убить; держатели Host не трогаются.
func (k *Keeper) adoptAll(saved plan) {
	files, _ := filepath.Glob(filepath.Join(k.home, "procs", "*.json"))
	for _, file := range files {
		var f struct {
			ID, Owner, Key, Tag string
			Port                int
		}
		if b, err := os.ReadFile(file); err != nil || json.Unmarshal(b, &f) != nil || f.Owner != "keeper" {
			continue
		}
		var e *entry
		for i, x := range saved.Parts {
			if x.Part == f.ID {
				e = &saved.Parts[i]
			}
		}
		h, err := attach(f.Port, f.Key)
		if err != nil {
			os.Remove(file)
			k.j.add("keeper", f.ID, "stop", "adopt", "id", f.ID, "why", "держатель не отвечает — файл убран: "+err.Error())
			continue
		}
		if e == nil {
			k.orphan(f.ID, h)
			continue
		}
		run := *e
		if run.Version != f.Tag {
			run = entry{Part: f.ID, Version: f.Tag, On: e.On, Env: e.Env}
		}
		p := &part{name: f.ID, run: run, want: &run, version: f.Tag, state: "running", h: h, pid: h.pid}
		k.locked(func() { k.parts[f.ID] = p })
		h.watch(func(h *held) { k.exited(p, h) })
		k.j.add("keeper", f.ID, "note", "adopt", "id", f.ID, "pid", h.pid, "version", f.Tag, "buffered", h.buffered)
	}
}

// orphan — держатель части, которой нет в плане: дерево убито, держатель выходит сам.
func (k *Keeper) orphan(id string, h *held) {
	h.watch(func(*held) {})
	h.kill()
	k.wait(h)
	k.j.add("keeper", id, "note", "orphan_kill", "id", id)
}
