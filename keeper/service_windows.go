package main

// Служба Windows этого флота — единственная установка на Windows: под текущим пользователем (пароль — второй строкой stdin), автостарт
// без входа, восстановление службы поднимает keeper после любого выхода, и после подмены себя. Ставит администратор. Своё имя уже стоит —
// install отказывает.
import (
	"bufio"
	"errors"
	"fmt"
	"os/exec"
	"os/user"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// uninstallWait — остановка службы при uninstall.
const uninstallWait = 3 * time.Minute

// handler — keeper как служба Windows: Stop и Shutdown — штатная остановка; подмена себя — выход с кодом, восстановление службы поднимает новый файл.
type handler struct{}

func (handler) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	s <- svc.Status{State: svc.StartPending}
	k, err := startKeeper(Options{})
	if err != nil {
		return true, 1
	}
	s <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case <-k.Done():
			return true, exitUpdated
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				s <- svc.Status{State: svc.StopPending}
				k.Stop()
				return false, 0
			}
		}
	}
}

func asService() bool { ok, _ := svc.IsWindowsService(); return ok }

func runService() int {
	if err := svc.Run(serviceName(), handler{}); err != nil {
		return 1
	}
	return 0
}

// serviceExists — служба этого имени есть; sc query спрашивает и без прав администратора.
func serviceExists() bool { return exec.Command("sc", "query", serviceName()).Run() == nil }

// grantServiceLogon — право «вход в качестве службы» пользователю: без него служба под пользователем не стартует (1069).
func grantServiceLogon(sid *windows.SID) error {
	advapi := windows.NewLazySystemDLL("advapi32.dll")
	var attrs [6]uintptr // LSA_OBJECT_ATTRIBUTES, нули; Length — первым полем
	attrs[0] = unsafe.Sizeof(attrs)
	var policy uintptr
	const createAccount, lookupNames = 0x10, 0x800
	if st, _, _ := advapi.NewProc("LsaOpenPolicy").Call(0, uintptr(unsafe.Pointer(&attrs)), createAccount|lookupNames, uintptr(unsafe.Pointer(&policy))); st != 0 {
		return fmt.Errorf("LsaOpenPolicy: %w", windows.NTStatus(st).Errno())
	}
	defer advapi.NewProc("LsaClose").Call(policy)
	name, _ := windows.UTF16FromString("SeServiceLogonRight")
	right := struct {
		Length, MaximumLength uint16
		Buffer                *uint16
	}{uint16((len(name) - 1) * 2), uint16(len(name) * 2), &name[0]}
	if st, _, _ := advapi.NewProc("LsaAddAccountRights").Call(policy, uintptr(unsafe.Pointer(sid)), uintptr(unsafe.Pointer(&right)), 1); st != 0 {
		return fmt.Errorf("LsaAddAccountRights: %w", windows.NTStatus(st).Errno())
	}
	return nil
}

func registered() error {
	if serviceExists() {
		return fmt.Errorf("%s уже стоит: сначала keeper uninstall", serviceName())
	}
	return nil
}

func register(dst string, in *bufio.Reader) error {
	password, _ := readLine(in)
	if password == "" {
		return errors.New("пароль пользователя для службы — второй строкой stdin")
	}
	u, err := user.Current()
	if err != nil {
		return err
	}
	sid, err := windows.StringToSid(u.Uid)
	if err == nil {
		err = grantServiceLogon(sid)
	}
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.CreateService(serviceName(), dst, mgr.Config{DisplayName: strings.TrimSpace("Switchboard keeper " + fleetName), StartType: mgr.StartAutomatic,
		ServiceStartName: u.Username, Password: password, Description: "Switchboard keeper: исполняет план машины"}, runArgs()...)
	if err != nil {
		return err
	}
	defer s.Close()
	// одно действие — оно же для каждого следующего сбоя; вышла с кодом — подмена себя или сбой: запустить снова
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: time.Second}}, 0); err != nil {
		return err
	}
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return err
	}
	return s.Start()
}

func unregister() error {
	if !serviceExists() {
		return fmt.Errorf("нет службы %s", serviceName())
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
	if st, err := s.Query(); err == nil && st.State != svc.Stopped {
		s.Control(svc.Stop)
		for end := time.Now().Add(uninstallWait); st.State != svc.Stopped; time.Sleep(time.Second) {
			if time.Now().After(end) {
				return fmt.Errorf("служба %s не остановилась за %v", serviceName(), uninstallWait)
			}
			if st, err = s.Query(); err != nil {
				return err
			}
		}
	}
	return s.Delete()
}
