package holder

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

// setHolderAttr — держатель: своя сессия, без «родитель умер — умри» — переживает хозяина.
func setHolderAttr(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

// Prepare — своя группа, родитель умер — умри: процесс части и служебные команды keeper.
func Prepare(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

// tree — группа процесса. detach на Linux не нужен: дети-держатели Host уходят в свою сессию сами.
type tree struct{ pgid int }

func newTree(cmd *exec.Cmd, _ bool) (*tree, error) { return &tree{cmd.Process.Pid}, nil }

func (t *tree) kill() { syscall.Kill(-t.pgid, syscall.SIGKILL) }

// exitOf — код выхода или имя сигнала.
func exitOf(ps *os.ProcessState) (int, string) {
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 0, unix.SignalName(ws.Signal())
	}
	return ps.ExitCode(), ""
}
