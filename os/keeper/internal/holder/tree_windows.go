package holder

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Prepare — своя группа консоли, без окна: Ctrl+C в консоли keeper не доходит до детей.
func Prepare(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
}

func setHolderAttr(cmd *exec.Cmd) { Prepare(cmd) }

// tree — задание Windows «закрыл — убей»: умер держатель — ОС завершает процесс со всеми потомками. detach — дети процесса из задания выходят тихо:
// держатели сессий переживают смену версии Host.
type tree struct{ job windows.Handle }

func newTree(cmd *exec.Cmd, detach bool) (*tree, error) {
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
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	return &tree{job}, nil
}

func (t *tree) kill() { windows.TerminateJobObject(t.job, 1) }

// exitOf — код выхода: сигналов на Windows нет.
func exitOf(ps *os.ProcessState) (int, string) { return ps.ExitCode(), "" }
