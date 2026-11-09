package main

// Служба Windows этого флота: под текущим пользователем (пароль — второй строкой stdin), автостарт без входа, ОС поднимает её после выхода.
// --logon — задача планировщика при входе пользователя, её ставит и не администратор: запуск при регистрации и при входе, повтор раз в
// минуту, второго экземпляра нет — так ОС поднимает keeper после подмены себя. Своё имя уже стоит — install отказывает.
import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
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

// hideConsole — окно консоли задачи при входе не видно.
func hideConsole() { windows.NewLazySystemDLL("kernel32.dll").NewProc("FreeConsole").Call() }

func taskExists() bool { return exec.Command("schtasks", "/Query", "/TN", serviceName()).Run() == nil }

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
	if serviceExists() || taskExists() {
		return fmt.Errorf("%s уже стоит: сначала keeper uninstall", serviceName())
	}
	return nil
}

func register(dst string, logon bool, in *bufio.Reader) error {
	args := runArgs()
	if logon {
		return registerTask(dst, append(args, "--hide"))
	}
	password, _ := readLine(in)
	if password == "" {
		return errors.New("пароль пользователя для службы — второй строкой stdin (или --logon — задача при входе)")
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
		ServiceStartName: u.Username, Password: password, Description: "Switchboard keeper: исполняет план машины"}, args...)
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

// logonTask — текст задачи в UTF-16 с меткой порядка байт: другого файла schtasks не принимает. Повтор висит на двух триггерах: «при регистрации» —
// с установки, «при входе» — после перезагрузки; только у входа повтор не шёл до первого входа.
func logonTask(dst string, args []string) []byte {
	xml := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Switchboard keeper: исполняет план машины при входе пользователя</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>%[1]s</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Triggers>
    <RegistrationTrigger><Repetition><Interval>PT1M</Interval></Repetition></RegistrationTrigger>
    <LogonTrigger><Repetition><Interval>PT1M</Interval></Repetition><UserId>%[1]s</UserId></LogonTrigger>
  </Triggers>
  <Actions Context="Author"><Exec><Command>%[2]s</Command><Arguments>%[3]s</Arguments></Exec></Actions>
</Task>
`, xmlText(os.Getenv("USERDOMAIN")+`\`+os.Getenv("USERNAME")), xmlText(dst), xmlText(strings.Join(args, " ")))
	b := []byte{0xff, 0xfe}
	for _, r := range utf16.Encode([]rune(xml)) {
		b = append(b, byte(r), byte(r>>8))
	}
	return b
}

func registerTask(dst string, args []string) error {
	file := filepath.Join(os.TempDir(), serviceName()+".xml")
	if err := os.WriteFile(file, logonTask(dst, args), 0o600); err != nil {
		return err
	}
	defer os.Remove(file)
	if out, err := exec.Command("schtasks", "/Create", "/TN", serviceName(), "/XML", file, "/F").CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func xmlText(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func unregister() error {
	if taskExists() {
		exec.Command("schtasks", "/End", "/TN", serviceName()).Run()
		if out, err := exec.Command("schtasks", "/Delete", "/TN", serviceName(), "/F").CombinedOutput(); err != nil {
			return fmt.Errorf("schtasks: %v: %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	}
	if !serviceExists() {
		return fmt.Errorf("нет ни службы, ни задачи %s", serviceName())
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
