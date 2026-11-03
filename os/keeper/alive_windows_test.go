//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

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

// 5524 · Служба или задача своего имени уже стоит — install отказывает словом; uninstall --name снимает только свою
// (дизайн «Любой агент», этап 0). Настоящие задачи планировщика: их может ставить не администратор.
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
	if exec.Command("schtasks", "/Query", "/TN", task(b)).Run() != nil {
		t.Fatal("чужая задача снята")
	}
}
