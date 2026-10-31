package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
)

// proc — процесс claude у keeper. Байты гонятся между каналом процесса и stdio, не разбираясь.
// Пока канал не подключён, вывод копится в buf и отдаётся следующему attach раньше живого потока.
type proc struct {
	k     *Keeper
	id    string
	pid   int
	cmd   *exec.Cmd
	osh   *osHandle
	stdin *os.File
	outR  *os.File
	errR  *os.File

	outMu sync.Mutex // порядок записи в канал: накопленное, затем живой поток
	mu    sync.Mutex // поля ниже
	conn  net.Conn
	buf   []byte
	done  bool
	// kill просил Host; forced — с force
	killed, forced bool
	lastErr        string
}

// startProc — запустить процесс по spawn; k.mu взят.
func (k *Keeper) startProc(h first) (*proc, error) {
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		return nil, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}
	cmd := exec.Command(h.Command, h.Args...)
	cmd.Dir = h.Cwd
	if h.Env != nil {
		// env — ровно то, что SDK передал в spawnClaudeCodeProcess
		keys := make([]string, 0, len(h.Env))
		for kk := range h.Env {
			keys = append(keys, kk)
		}
		sort.Strings(keys)
		cmd.Env = make([]string, 0, len(keys))
		for _, kk := range keys {
			cmd.Env = append(cmd.Env, kk+"="+h.Env[kk])
		}
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	setProcAttr(cmd)
	err = cmd.Start()
	inR.Close()
	outW.Close()
	errW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		errR.Close()
		return nil, err
	}
	osh, err := afterStart(cmd.Process)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		inW.Close()
		outR.Close()
		errR.Close()
		return nil, err
	}
	return &proc{k: k, id: h.ID, pid: cmd.Process.Pid, cmd: cmd, osh: osh, stdin: inW, outR: outR, errR: errR}, nil
}

func (k *Keeper) serveSpawn(c net.Conn, br *bufio.Reader, h first) {
	k.mu.Lock()
	if k.stopping {
		k.mu.Unlock()
		k.refuse(c, "spawn", "shutting_down", "spawn «"+h.ID+"»: keeper останавливается", "id", h.ID)
		return
	}
	if _, ok := k.procs[h.ID]; ok {
		k.mu.Unlock()
		k.refuse(c, "spawn", "in_use", "spawn «"+h.ID+"»: процесс с этим id жив", "id", h.ID)
		return
	}
	p, err := k.startProc(h)
	if err != nil {
		k.mu.Unlock()
		k.refuse(c, "spawn", "spawn_failed", "spawn «"+h.ID+"»: "+err.Error(), "id", h.ID, "command", h.Command)
		return
	}
	p.conn = c
	k.procs[h.ID] = p
	k.procWG.Add(1)
	k.mu.Unlock()
	// ответ раньше первого байта вывода: чтение вывода стартует после него
	_, werr := c.Write(okLine(map[string]int{"pid": p.pid}))
	if werr != nil {
		p.mu.Lock()
		p.conn = nil
		p.mu.Unlock()
		c.Close()
	}
	k.j.note("spawn", "id", h.ID, "pid", p.pid)
	go p.run()
	if werr == nil {
		go p.pumpIn(c, br)
	}
}

func (k *Keeper) serveAttach(c net.Conn, br *bufio.Reader, id string) {
	k.mu.Lock()
	p := k.procs[id]
	k.mu.Unlock()
	if p == nil {
		k.refuse(c, "attach", "unknown_id", "attach: процесса «"+id+"» нет", "id", id)
		return
	}
	switch word := p.attach(c); word {
	case "":
		go p.pumpIn(c, br)
	case "in_use":
		k.refuse(c, "attach", word, "attach «"+id+"»: канал процесса уже подключён", "id", id)
	default:
		k.refuse(c, "attach", word, "attach: процесс «"+id+"» уже вышел", "id", id)
	}
}

// attach — подключить канал: ответ, накопленный вывод, затем живой поток. "" — подключён.
func (p *proc) attach(c net.Conn) string {
	p.outMu.Lock()
	defer p.outMu.Unlock()
	p.mu.Lock()
	if p.done {
		p.mu.Unlock()
		return "unknown_id"
	}
	if p.conn != nil {
		p.mu.Unlock()
		return "in_use"
	}
	buf := p.buf
	p.buf, p.conn = nil, c
	p.mu.Unlock()
	p.k.j.note("attach", "id", p.id, "buffered", len(buf))
	msg := okLine(map[string]int{"pid": p.pid, "buffered": len(buf)})
	if _, err := c.Write(append(msg, buf...)); err != nil {
		// канал умер сразу: накопленное остаётся у keeper
		p.mu.Lock()
		if p.conn == c {
			p.conn = nil
		}
		p.buf = append(buf, p.buf...)
		p.mu.Unlock()
		c.Close()
	}
	return ""
}

// run — читать вывод и stderr до конца, дождаться выхода, отдать exited.
func (p *proc) run() {
	outDone, errDone := make(chan struct{}), make(chan struct{})
	go func() {
		b := make([]byte, 32*1024)
		for {
			n, err := p.outR.Read(b)
			if n > 0 {
				p.deliver(b[:n])
			}
			if err != nil {
				break
			}
		}
		close(outDone)
	}()
	go func() {
		readLines(p.errR, func(s string) {
			p.k.j.note("stderr", "id", p.id, "line", s)
			if strings.TrimSpace(s) != "" {
				p.mu.Lock()
				p.lastErr = s
				p.mu.Unlock()
			}
		})
		close(errDone)
	}()
	p.cmd.Wait()
	// процесс вышел — его потомки тоже: иначе они держали бы трубы
	p.osh.killTree()
	<-outDone
	<-errDone
	p.outR.Close()
	p.errR.Close()
	p.osh.release()
	p.finish()
}

// deliver — кусок вывода: в канал, если он подключён, иначе — в память.
func (p *proc) deliver(chunk []byte) {
	p.outMu.Lock()
	defer p.outMu.Unlock()
	p.mu.Lock()
	c := p.conn
	if c == nil {
		p.buf = append(p.buf, chunk...)
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	n, err := c.Write(chunk)
	if err != nil {
		p.mu.Lock()
		mine := p.conn == c
		if mine {
			p.conn = nil
		}
		p.buf = append(p.buf, chunk[n:]...)
		p.mu.Unlock()
		c.Close()
		if mine {
			p.k.j.note("detach", "id", p.id, "why", "запись в канал: "+err.Error())
		}
	}
}

// pumpIn — ввод сессии из канала в stdin процесса. Конец канала процесс не трогает.
func (p *proc) pumpIn(c net.Conn, br *bufio.Reader) {
	b := make([]byte, 32*1024)
	for {
		n, err := br.Read(b)
		if n > 0 {
			p.stdin.Write(b[:n]) // ввод закрыт по kill — байты некуда деть
		}
		if err != nil {
			break
		}
	}
	p.mu.Lock()
	mine := p.conn == c
	if mine {
		p.conn = nil
	}
	p.mu.Unlock()
	c.Close()
	if mine {
		p.k.j.note("detach", "id", p.id)
	}
}

// kill — без force закрыть ввод (claude выходит сам); с force — процесс и потомки сразу.
func (p *proc) kill(force bool) {
	p.mu.Lock()
	p.killed = true
	p.forced = p.forced || force
	p.mu.Unlock()
	if force {
		p.osh.killTree()
	} else {
		p.stdin.Close()
	}
}

func (p *proc) gone() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.done
}

type exitedEv struct {
	Op     string  `json:"op"`
	ID     string  `json:"id"`
	Pid    int     `json:"pid"`
	Code   *int    `json:"code"`
	Signal *string `json:"signal"`
	Stderr string  `json:"stderr"`
}

// finish — весь вывод отдан; канал закрыт на запись; процесс забыт; exited — Host.
func (p *proc) finish() {
	p.outMu.Lock()
	p.mu.Lock()
	p.done = true
	c := p.conn
	p.conn, p.buf = nil, nil
	killed, forced, lastErr := p.killed, p.forced, p.lastErr
	p.mu.Unlock()
	p.outMu.Unlock()
	if c != nil {
		// конец вывода; соединение закроет pumpIn, когда Host закроет своё
		if tc, ok := c.(interface{ CloseWrite() error }); ok {
			tc.CloseWrite()
		} else {
			c.Close()
		}
	}
	p.stdin.Close()
	code, sig := exitInfo(p.cmd.ProcessState, forced)
	ev := line(exitedEv{Op: "exited", ID: p.id, Pid: p.pid, Code: code, Signal: sig, Stderr: lastErr})

	k := p.k
	k.mu.Lock()
	if k.procs[p.id] == p {
		delete(k.procs, p.id)
	}
	k.mu.Unlock()
	kv := []any{"id", p.id, "pid", p.pid, "code", code, "signal", sig, "stderr", lastErr}
	if killed {
		k.j.note("exited", kv...)
	} else {
		k.j.stop("exited", fmt.Sprintf("процесс %s вышел не по просьбе: %s", p.id, exitWords(code, sig, lastErr)), kv...)
	}
	k.exited(ev)
	k.procWG.Done()
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
		s += " · " + lastErr
	}
	return s
}
