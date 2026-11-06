//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// detachProc — держатель без хозяина: своя группа, без окна.
func detachProc(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
}

func alive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, _ := windows.WaitForSingleObject(h, 0)
	return ev == uint32(windows.WAIT_TIMEOUT)
}

func killPid(t *testing.T, pid int) {
	t.Helper()
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		t.Fatalf("kill %d: %v", pid, err)
	}
	defer windows.CloseHandle(h)
	windows.TerminateProcess(h, 3)
}

// 5524 · 5566 · Служба или задача своего имени уже стоит — install отказывает словом; uninstall --name снимает только свою; uninstall имени,
// которого нет, — код 1, причина словом (дизайн «Любой агент», этап 0; устав «система ловит»). Настоящие задачи планировщика: их может ставить
// не администратор.
func TestEtNameOwnTaskOnly(t *testing.T) {
	a, b := fmt.Sprintf("t%da", os.Getpid()), fmt.Sprintf("t%db", os.Getpid())
	task := func(n string) string { return "switchboard-keeper-" + n }
	for _, n := range []string{a, b} {
		if out, err := exec.Command("schtasks", "/Create", "/TN", task(n), "/TR", "cmd /c exit", "/SC", "ONCE", "/ST", "23:59", "/F").CombinedOutput(); err != nil {
			t.Fatalf("schtasks: %v: %s", err, out)
		}
		t.Cleanup(func() { exec.Command("schtasks", "/Delete", "/TN", task(n), "/F").Run() })
	}
	home := t.TempDir()
	if code, _, e := runKeeper(t, home, "invite\n", "install", "--name", a); code == 0 || !strings.Contains(e, "уже стоит") || !strings.Contains(e, task(a)) {
		t.Fatalf("второй install: код %d, %q", code, e)
	}
	if code, _, e := runKeeper(t, home, "", "uninstall", "--name", a); code != 0 {
		t.Fatalf("uninstall: код %d, %q", code, e)
	}
	if exec.Command("schtasks", "/Query", "/TN", task(a)).Run() == nil {
		t.Fatal("своя задача не снята")
	}
	if code, _, e := runKeeper(t, home, "", "uninstall", "--name", fmt.Sprintf("t%dx", os.Getpid())); code != 1 || !strings.Contains(e, "uninstall") {
		t.Fatalf("uninstall неизвестного: код %d, %q", code, e)
	}
	if exec.Command("schtasks", "/Query", "/TN", task(b)).Run() != nil {
		t.Fatal("чужая задача снята")
	}
}

// Задача при входе: запуск при регистрации и при входе, повтор раз в минуту, второго экземпляра нет — так ОС поднимает keeper после подмены себя; файл —
// UTF-16 с меткой порядка байт (замер 1 нояб.; живой прогон 1 нояб., win: только у входа повтор не шёл до первого входа). Текст, а не настоящая задача:
// она запустила бы keeper в настоящем профиле пользователя.
func TestEtLogonTaskText(t *testing.T) {
	b := logonTask(`C:\k&v\keeper.exe`, []string{"run", "--name", "x", "--hide"})
	if b[0] != 0xff || b[1] != 0xfe {
		t.Fatal("нет метки порядка байт")
	}
	u := make([]uint16, (len(b)-2)/2)
	for i := range u {
		u[i] = uint16(b[2+2*i]) | uint16(b[3+2*i])<<8
	}
	text := string(utf16.Decode(u))
	for _, want := range []string{"<RegistrationTrigger><Repetition><Interval>PT1M</Interval>", "<LogonTrigger><Repetition><Interval>PT1M</Interval>", "<MultipleInstancesPolicy>IgnoreNew",
		"<ExecutionTimeLimit>PT0S", `<Command>C:\k&amp;v\keeper.exe</Command>`, "<Arguments>run --name x --hide</Arguments>"} {
		if !strings.Contains(text, want) {
			t.Fatalf("нет %s в %s", want, text)
		}
	}
}

// 7307 · служба Windows: Stop и Shutdown — штатная остановка keeper: Stopped с кодом 0, последняя строка keeper в журнале — keeper_exit
// (устав «каждая часть останавливается штатно»; чьё: код — handler.Execute). Диспетчер служб в тесте не нужен: Execute — обычный метод.
func TestEtServiceStop(t *testing.T) {
	for _, cmd := range []svc.Cmd{svc.Stop, svc.Shutdown} {
		home := t.TempDir()
		t.Setenv("SWITCHBOARD_HOME", home)
		r := make(chan svc.ChangeRequest)
		s := make(chan svc.Status, 8)
		type out struct {
			special bool
			code    uint32
		}
		done := make(chan out, 1)
		go func() {
			a, b := handler{}.Execute(nil, r, s)
			done <- out{a, b}
		}()
		deadline := time.After(30 * time.Second)
		for running := false; !running; {
			select {
			case st := <-s:
				running = st.State == svc.Running
			case <-deadline:
				t.Fatal("служба не дошла до Running")
			}
		}
		r <- svc.ChangeRequest{Cmd: cmd}
		select {
		case o := <-done:
			if o.special || o.code != 0 {
				t.Fatalf("выход службы: %v %d", o.special, o.code)
			}
		case <-deadline:
			t.Fatal("служба не остановилась")
		}
		if l := lastKeeperLine(home); l["ev"] != "keeper_exit" {
			t.Fatalf("последняя строка keeper: %v", l)
		}
	}
}

// apart — этот процесс без видимого окна консоли.
func apart() bool {
	h, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow").Call()
	if h == 0 {
		return true
	}
	v, _, _ := windows.NewLazySystemDLL("user32.dll").NewProc("IsWindowVisible").Call(h)
	return v == 0
}

// Папку прежней версии не удалить: занята — строка cleanup с причиной, версия остаётся до следующей смены (чьё: код — «занятую ОС не даёт удалить»; находка
// сверки 6 нояб.).
func TestEtBusyVersionCleanup(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	s.online()
	busy := filepath.Join(verDir(s.home, "capture", "0.9.0"), "busy")
	os.MkdirAll(filepath.Dir(busy), 0o700)
	os.WriteFile(busy, nil, 0o600)
	name, _ := windows.UTF16PtrFromString(busy)
	h, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { windows.CloseHandle(h) })
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "1.4.0 running", running(k, "capture", "1.4.0"))
	waitFor(t, "строка cleanup", func() bool { return has(s.home, J{"part": "capture", "ev": "cleanup", "version": "0.9.0", "why": sub("занята")}) })
}

// Отказ LSA — словом: администратор видит причину, а не номер статуса (устав: «ошибки — словами»; чьё: код — LsaNtStatusToWinError). Пустой SID: право
// никому не выдаётся, у администратора отказывает LsaAddAccountRights, у остальных LsaOpenPolicy.
func TestEtServiceLogonRefusalWord(t *testing.T) {
	err := grantServiceLogon(nil)
	if err == nil || strings.Contains(err.Error(), "0x") {
		t.Fatalf("отказ: %v", err)
	}
}
