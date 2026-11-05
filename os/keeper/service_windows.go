package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// removeWait — предел остановки службы при снятии: больше своего хода остановки keeper.
const removeWait = 3 * time.Minute

func isService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

func runService() {
	if err := svc.Run(serviceName(), handler{}); err != nil {
		os.Exit(1)
	}
}

type handler struct{}

// Execute — служба: Stop и Shutdown — штатная остановка keeper. Таймер — только у ОС. Остановился сам — причина в журнале; восстановление службы запустит снова.
func (handler) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	s <- svc.Status{State: svc.StartPending}
	k, err := start(nil)
	if err != nil {
		return true, 1
	}
	s <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				s <- svc.Status{State: svc.StopPending}
				k.Stop()
				return false, 0
			}
		case <-k.Done():
			return true, 1
		}
	}
}

func taskExists() bool { return exec.Command("schtasks", "/Query", "/TN", serviceName()).Run() == nil }

// checkFree — служба или задача своего имени уже стоит. Служба — запросом без прав администратора: --logon ставит не админ.
func checkFree() error {
	if taskExists() || exec.Command("sc", "query", serviceName()).Run() == nil {
		return fmt.Errorf("keeper уже стоит службой или задачей %s — сначала keeper uninstall", serviceName())
	}
	return nil
}

// account — домен\имя текущего пользователя и его SID.
func account() (string, *windows.SID, error) {
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", nil, err
	}
	acc, dom, _, err := tu.User.Sid.LookupAccount("")
	if err != nil {
		return "", nil, err
	}
	return dom + `\` + acc, tu.User.Sid, nil
}

// register — служба под учётной записью текущего пользователя: стартует с системой, без входа, и видит ту же папку машины. Пароль Windows — строкой из stdin;
// его получает только диспетчер служб. --logon — задача при входе.
func register(exe string, logon bool, in *bufio.Reader) error {
	if logon {
		return registerLogon(exe)
	}
	pw, err := readLine(in)
	if err != nil {
		return err
	}
	user, sid, err := account()
	if err != nil {
		return err
	}
	if err := grantServiceLogon(sid); err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.CreateService(serviceName(), exe, mgr.Config{
		// имя в диспетчере служб тоже уникально: без имени флота вторая служба не создаётся
		DisplayName:      strings.TrimSpace("Switchboard keeper " + fleetName),
		Description:      "Исполняет план машины Switchboard: держит Host и приложения через держатели.",
		StartType:        mgr.StartAutomatic,
		ServiceStartName: user,
		Password:         pw,
	}, runArgs()...)
	if err != nil {
		return err
	}
	defer s.Close()
	// вышла с кодом — подмена себя или сбой: запустить снова
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: time.Second}}, 0); err != nil {
		return err
	}
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return err
	}
	return s.Start()
}

// unregister — снять только своё. Задача снята — запущенный по ней keeper остановлен тоже, иначе он жил бы рядом со следующей установкой.
func unregister() error {
	if taskExists() {
		for _, args := range [][]string{{"/End", "/TN", serviceName()}, {"/Delete", "/TN", serviceName(), "/F"}} {
			if out, err := exec.Command("schtasks", args...).CombinedOutput(); err != nil {
				return fmt.Errorf("schtasks %s: %v: %s", args[0], err, out)
			}
		}
		return nil
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName())
	if err != nil {
		return err
	}
	defer s.Close()
	st, err := s.Query()
	if err == nil && st.State != svc.Stopped {
		if _, err := s.Control(svc.Stop); err != nil {
			return err
		}
		for end := time.Now().Add(removeWait); st.State != svc.Stopped; time.Sleep(300 * time.Millisecond) {
			if time.Now().After(end) {
				return fmt.Errorf("служба %s не остановилась за %v", serviceName(), removeWait)
			}
			if st, err = s.Query(); err != nil {
				return err
			}
		}
	}
	return s.Delete()
}

// grantServiceLogon — право «вход в качестве службы» (SeServiceLogonRight): без него служба под пользователем не стартует. В x/sys этих вызовов нет.
func grantServiceLogon(sid *windows.SID) error {
	advapi := windows.NewLazySystemDLL("advapi32.dll")
	ntErr := func(op string, st uintptr) error {
		w, _, _ := advapi.NewProc("LsaNtStatusToWinError").Call(st)
		return fmt.Errorf("%s: %w", op, windows.Errno(w))
	}
	var attrs struct {
		Length                   uint32
		RootDirectory            uintptr
		ObjectName               uintptr
		Attributes               uint32
		SecurityDescriptor       uintptr
		SecurityQualityOfService uintptr
	}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	const policyCreateAccount, policyLookupNames = 0x10, 0x800
	var policy uintptr
	if st, _, _ := advapi.NewProc("LsaOpenPolicy").Call(0, uintptr(unsafe.Pointer(&attrs)), policyCreateAccount|policyLookupNames, uintptr(unsafe.Pointer(&policy))); st != 0 {
		return ntErr("LsaOpenPolicy", st)
	}
	defer advapi.NewProc("LsaClose").Call(policy)
	name, _ := windows.UTF16FromString("SeServiceLogonRight")
	right := struct {
		Length, MaximumLength uint16
		Buffer                *uint16
	}{uint16((len(name) - 1) * 2), uint16(len(name) * 2), &name[0]}
	if st, _, _ := advapi.NewProc("LsaAddAccountRights").Call(policy, uintptr(unsafe.Pointer(sid)), uintptr(unsafe.Pointer(&right)), 1); st != 0 {
		return ntErr("LsaAddAccountRights", st)
	}
	return nil
}
