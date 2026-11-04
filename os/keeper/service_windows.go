//go:build windows

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

// install — служба под учётной записью текущего пользователя: стартует с системой, без входа. Пароль Windows — одной строкой из stdin; его получает только
// диспетчер служб.
func install(args []string) error {
	f, err := parseInstall(args)
	if err != nil {
		return err
	}
	// второй вид установки поверх первого — два keeper на одних держателях: отказ до правки файлов
	if installed() {
		return fmt.Errorf("keeper уже стоит службой или задачей %s — сначала keeper uninstall", serviceName())
	}
	in := bufio.NewReader(os.Stdin)
	if err := prepareConf(f, in); err != nil {
		return err
	}
	if f.logon {
		return installLogonTask()
	}
	pw, err := readLine(in)
	if err != nil {
		return err
	}
	exe, err := placeSelf()
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
	// упал — запустить снова
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: time.Second}}, 0); err != nil {
		return err
	}
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return err
	}
	return s.Start()
}

// installed — служба или задача keeper уже есть. Служба — запросом без прав администратора: --logon ставит не админ.
func installed() bool {
	if m, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT); err == nil {
		defer windows.CloseServiceHandle(m)
		name, _ := windows.UTF16PtrFromString(serviceName())
		if s, err := windows.OpenService(m, name, windows.SERVICE_QUERY_STATUS); err == nil {
			windows.CloseServiceHandle(s)
			return true
		}
	}
	return taskInstalled()
}

func taskInstalled() bool {
	return exec.Command("schtasks", "/Query", "/TN", serviceName()).Run() == nil
}

// uninstallWait — предел ожидания остановки службы при снятии: больше своего хода остановки keeper.
const uninstallWait = 3 * time.Minute

func uninstall() error {
	if taskInstalled() {
		// задача снята — запущенный по ней keeper остановлен тоже, иначе он жил бы рядом со следующей установкой
		if out, err := exec.Command("schtasks", "/End", "/TN", serviceName()).CombinedOutput(); err != nil {
			return fmt.Errorf("schtasks /End: %v: %s", err, out)
		}
		if out, err := exec.Command("schtasks", "/Delete", "/TN", serviceName(), "/F").CombinedOutput(); err != nil {
			return fmt.Errorf("schtasks /Delete: %v: %s", err, out)
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
		for end := time.Now().Add(uninstallWait); st.State != svc.Stopped; {
			if time.Now().After(end) {
				return fmt.Errorf("служба %s не остановилась за %v", serviceName(), uninstallWait)
			}
			time.Sleep(300 * time.Millisecond)
			if st, err = s.Query(); err != nil {
				return err
			}
		}
	}
	return s.Delete()
}

// grantServiceLogon — право «вход в качестве службы» (SeServiceLogonRight): без него служба под пользователем не стартует.
func grantServiceLogon(sid *windows.SID) error {
	advapi := windows.NewLazySystemDLL("advapi32.dll")
	ntErr := func(op string, st uintptr) error {
		w, _, _ := advapi.NewProc("LsaNtStatusToWinError").Call(st)
		return fmt.Errorf("%s: %w", op, windows.Errno(w))
	}
	type lsaString struct {
		Length, MaximumLength uint16
		Buffer                *uint16
	}
	type lsaAttributes struct {
		Length                   uint32
		RootDirectory            uintptr
		ObjectName               uintptr
		Attributes               uint32
		SecurityDescriptor       uintptr
		SecurityQualityOfService uintptr
	}
	const policyCreateAccount, policyLookupNames = 0x10, 0x800
	var attrs lsaAttributes
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var policy uintptr
	if st, _, _ := advapi.NewProc("LsaOpenPolicy").Call(0, uintptr(unsafe.Pointer(&attrs)), policyCreateAccount|policyLookupNames, uintptr(unsafe.Pointer(&policy))); st != 0 {
		return ntErr("LsaOpenPolicy", st)
	}
	defer advapi.NewProc("LsaClose").Call(policy)
	name, _ := windows.UTF16FromString("SeServiceLogonRight")
	right := lsaString{Length: uint16((len(name) - 1) * 2), MaximumLength: uint16(len(name) * 2), Buffer: &name[0]}
	if st, _, _ := advapi.NewProc("LsaAddAccountRights").Call(policy, uintptr(unsafe.Pointer(sid)), uintptr(unsafe.Pointer(&right)), 1); st != 0 {
		return ntErr("LsaAddAccountRights", st)
	}
	return nil
}
