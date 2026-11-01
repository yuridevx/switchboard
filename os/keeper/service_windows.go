//go:build windows

package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"os"
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
	if err := svc.Run(serviceName, handler{}); err != nil {
		os.Exit(1)
	}
}

type handler struct{}

// Execute — служба: Stop и Shutdown — штатная остановка keeper. Таймер — только у ОС.
func (handler) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	s <- svc.Status{State: svc.StartPending}
	home, err := homeDir()
	if err != nil {
		return true, 1
	}
	k, err := Start(home, nil)
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
			// keeper остановился сам — причина в журнале; восстановление службы запустит снова
			return true, 1
		}
	}
}

// install — служба под учётной записью текущего пользователя: стартует с системой, без входа.
// Пароль Windows — одной строкой из stdin; его получает только диспетчер служб.
func install(args []string) error {
	f, err := parseInstall(args)
	if err != nil {
		return err
	}
	in := bufio.NewReader(os.Stdin)
	if err := prepareConf(f, in); err != nil {
		return err
	}
	if f.logon {
		return installLogonTask()
	}
	pw, err := readSecretLine(in)
	if err != nil {
		return err
	}
	exe, err := placeSelf()
	if err != nil {
		return err
	}
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	acc, dom, _, err := tu.User.Sid.LookupAccount("")
	if err != nil {
		return err
	}
	if err := grantServiceLogon(tu.User.Sid); err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.CreateService(serviceName, exe, mgr.Config{
		DisplayName:      "Switchboard keeper",
		Description:      "Исполняет план машины Switchboard: держит Host и приложения через держатели.",
		StartType:        mgr.StartAutomatic,
		ServiceStartName: dom + `\` + acc,
		Password:         pw,
	})
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

func uninstall() error {
	if out, err := exec.Command("schtasks", "/Query", "/TN", serviceName).CombinedOutput(); err == nil {
		if out, err := exec.Command("schtasks", "/Delete", "/TN", serviceName, "/F").CombinedOutput(); err != nil {
			return fmt.Errorf("schtasks /Delete: %v: %s", err, out)
		}
		_ = out
		return nil
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	if st, err := s.Query(); err == nil && st.State != svc.Stopped {
		if _, err := s.Control(svc.Stop); err != nil {
			return err
		}
		for st.State != svc.Stopped {
			time.Sleep(300 * time.Millisecond)
			if st, err = s.Query(); err != nil {
				return err
			}
		}
	}
	return s.Delete()
}

// grantServiceLogon — право «вход в качестве службы» (SeServiceLogonRight) для учётной записи:
// без него служба под пользователем не стартует.
func grantServiceLogon(sid *windows.SID) error {
	advapi := windows.NewLazySystemDLL("advapi32.dll")
	open := advapi.NewProc("LsaOpenPolicy")
	add := advapi.NewProc("LsaAddAccountRights")
	closeP := advapi.NewProc("LsaClose")
	toWin := advapi.NewProc("LsaNtStatusToWinError")
	type lsaString struct {
		Length, MaximumLength uint16
		Buffer                *uint16
	}
	type lsaAttrs struct {
		Length                   uint32
		RootDirectory            uintptr
		ObjectName               uintptr
		Attributes               uint32
		SecurityDescriptor       uintptr
		SecurityQualityOfService uintptr
	}
	const policyCreateAccount, policyLookupNames = 0x10, 0x800
	ntErr := func(op string, st uintptr) error {
		w, _, _ := toWin.Call(st)
		return fmt.Errorf("%s: %w", op, windows.Errno(w))
	}
	attrs := lsaAttrs{}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var policy uintptr
	if st, _, _ := open.Call(0, uintptr(unsafe.Pointer(&attrs)), policyCreateAccount|policyLookupNames, uintptr(unsafe.Pointer(&policy))); st != 0 {
		return ntErr("LsaOpenPolicy", st)
	}
	defer closeP.Call(policy)
	name, _ := windows.UTF16FromString("SeServiceLogonRight")
	right := lsaString{Length: uint16((len(name) - 1) * 2), MaximumLength: uint16(len(name) * 2), Buffer: &name[0]}
	if st, _, _ := add.Call(policy, uintptr(unsafe.Pointer(sid)), uintptr(unsafe.Pointer(&right)), 1); st != 0 {
		return ntErr("LsaAddAccountRights", st)
	}
	return nil
}
