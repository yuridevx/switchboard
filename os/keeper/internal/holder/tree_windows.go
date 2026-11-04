//go:build windows

package holder

import (
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// tree — задание Windows (Job Object) с KILL_ON_JOB_CLOSE: умер держатель — ОС закрывает задание и завершает процесс со всеми потомками.
type tree struct {
	mu  sync.Mutex
	job windows.Handle
}

// SetProcAttr — своя группа консоли, без окна: Ctrl+C в консоли keeper не доходит до детей.
func SetProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
}

// setHolderAttr — держатель вне задания хозяина: переживает хозяина.
func setHolderAttr(cmd *exec.Cmd) { SetProcAttr(cmd) }

// enclose — процесс в своё задание; detach — дети процесса из задания выходят тихо.
func enclose(p *os.Process, detach bool) (*tree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if detach {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(p.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	return &tree{job: job}, nil
}

// kill — процесс и все его потомки сразу.
func (t *tree) kill() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job != 0 {
		windows.TerminateJobObject(t.job, 1)
	}
}

// release — закрыть задание; что в нём осталось, ОС завершает.
func (t *tree) release() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job != 0 {
		windows.CloseHandle(t.job)
		t.job = 0
	}
}

// exitOf — код выхода; завершённый силой — сигнал SIGKILL, как на Linux.
func exitOf(ps *os.ProcessState, forced bool) (*int, *string) {
	if forced {
		s := "SIGKILL"
		return nil, &s
	}
	c := ps.ExitCode()
	return &c, nil
}
