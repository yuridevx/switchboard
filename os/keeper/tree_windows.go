package main

import (
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// tree — процесс держателя и его потомки: задание Windows; держатель умер — задание закрыто, процесс снят. С --detach-children потомки
// выходят из задания сами (так Host отпускает держатели своих сессий).
type tree struct {
	mu     sync.Mutex // снятие по пределу идёт своей горутиной рядом с reap
	job    windows.Handle
	detach bool
}

func newTree(cmd *exec.Cmd, detach bool) *tree {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
	t := &tree{detach: detach}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return t
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if detach {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
	}
	windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	t.job = job
	return t
}

func (t *tree) adopt(p *os.Process) {
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(p.Pid))
	if err != nil {
		return
	}
	windows.AssignProcessToJobObject(t.job, h)
	windows.CloseHandle(h)
}

func (t *tree) kill() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job != 0 {
		windows.TerminateJobObject(t.job, 1)
	}
}

// reap — процесс вышел: потомки в задании тоже; отпущенные (--detach-children) живут. Задание закрыто.
func (t *tree) reap() {
	if !t.detach {
		t.kill()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job != 0 {
		windows.CloseHandle(t.job)
		t.job = 0
	}
}

func signalOf(*os.ProcessState) string { return "" }

// detached — держатель живёт без того, кто его запустил: своя группа, без окна.
func detached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
}
