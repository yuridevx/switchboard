package main

import (
	"os"
	"os/exec"
	"runtime"
	"syscall"

	"golang.org/x/sys/unix"
)

// tree — процесс держателя и его потомки: своя группа процессов; держатель умер — процесс получает SIGKILL. Кто ушёл в свою сессию
// (держатели сессий Host), тот вне группы.
type tree struct{ pgid int }

func newTree(cmd *exec.Cmd, _ bool) *tree {
	runtime.LockOSThread() // Pdeathsig — по нити, запустившей процесс: она живёт, пока жив держатель
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	return &tree{}
}

func (t *tree) adopt(p *os.Process) { t.pgid = p.Pid }

func (t *tree) kill() {
	if t.pgid > 0 {
		syscall.Kill(-t.pgid, syscall.SIGKILL)
	}
}

// reap — процесс вышел: потомки в его группе тоже.
func (t *tree) reap() { t.kill() }

func signalOf(s *os.ProcessState) string {
	if ws, ok := s.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return unix.SignalName(ws.Signal())
	}
	return ""
}

// detached — держатель живёт без того, кто его запустил: своя сессия.
func detached(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
