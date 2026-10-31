//go:build linux

package main

import (
	"os"
	"os/exec"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// osHandle — своя группа процессов: force завершает всю группу.
// keeper умер — PDEATHSIG завершает процесс, systemd — всю cgroup службы.
type osHandle struct {
	mu   sync.Mutex
	pgid int
}

func setProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

func afterStart(p *os.Process) (*osHandle, error) { return &osHandle{pgid: p.Pid}, nil }

// killTree — SIGKILL всей группе процесса.
func (o *osHandle) killTree() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.pgid > 0 {
		syscall.Kill(-o.pgid, syscall.SIGKILL)
	}
}

func (o *osHandle) release() {
	o.mu.Lock()
	o.pgid = 0
	o.mu.Unlock()
}

func exitInfo(ps *os.ProcessState, forced bool) (*int, *string) {
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		s := unix.SignalName(ws.Signal())
		return nil, &s
	}
	c := ps.ExitCode()
	return &c, nil
}
