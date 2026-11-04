//go:build linux

package holder

import (
	"os"
	"os/exec"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// tree — своя группа процессов: сила завершает всю группу. Умер держатель — PDEATHSIG завершает процесс, systemd — всю cgroup службы.
type tree struct {
	mu   sync.Mutex
	pgid int
}

// SetProcAttr — своя группа, родитель умер — умри.
func SetProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

// setHolderAttr — держатель: своя сессия, без «родитель умер — умри» — переживает хозяина.
func setHolderAttr(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

// enclose — группа процесса; detach на Linux не нужен: дети держателей Host уходят в свою сессию сами.
func enclose(p *os.Process, _ bool) (*tree, error) { return &tree{pgid: p.Pid}, nil }

func (t *tree) kill() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.pgid > 0 {
		syscall.Kill(-t.pgid, syscall.SIGKILL)
	}
}

func (t *tree) release() {
	t.mu.Lock()
	t.pgid = 0
	t.mu.Unlock()
}

func exitOf(ps *os.ProcessState, _ bool) (*int, *string) {
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		s := unix.SignalName(ws.Signal())
		return nil, &s
	}
	c := ps.ExitCode()
	return &c, nil
}
