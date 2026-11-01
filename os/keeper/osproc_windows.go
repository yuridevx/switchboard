//go:build windows

package main

import (
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// osHandle — задание Windows (Job Object) процесса с KILL_ON_JOB_CLOSE:
// keeper умер — ОС закрывает задание и завершает процесс со всеми потомками.
type osHandle struct {
	mu  sync.Mutex
	job windows.Handle
}

// setProcAttr — своя группа консоли: Ctrl+C в консоли keeper не доходит до детей.
func setProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
}

// setHolderAttr — держатель: своя группа, без окна, без задания хозяина — переживает хозяина.
func setHolderAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
}

// afterStart — процесс в своё задание «закрыл — убей»; detach — дети процесса из задания выходят тихо.
func afterStart(p *os.Process, detach bool) (*osHandle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if detach {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
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
	return &osHandle{job: job}, nil
}

// killTree — процесс и все его потомки сразу.
func (o *osHandle) killTree() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.job != 0 {
		windows.TerminateJobObject(o.job, 1)
	}
}

// release — закрыть задание; что в нём осталось, ОС завершает.
func (o *osHandle) release() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.job != 0 {
		windows.CloseHandle(o.job)
		o.job = 0
	}
}

// exitInfo — код выхода; завершённый по force — signal SIGKILL, как у Linux.
func exitInfo(ps *os.ProcessState, forced bool) (*int, *string) {
	if forced {
		s := "SIGKILL"
		return nil, &s
	}
	c := ps.ExitCode()
	return &c, nil
}
