//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

// startKeeperProc — keeper как служба systemd --user (KillMode=mixed, как в юните установщика):
// потомков после смерти keeper завершает systemd вместе с cgroup.
func startKeeperProc(t *testing.T, home string) int {
	if err := exec.Command("systemctl", "--user", "show-environment").Run(); err != nil {
		t.Skip("нет systemd --user: эталон 21 на Linux проверяется только под службой")
	}
	unit := fmt.Sprintf("keeper-et21-%d", os.Getpid())
	out, err := exec.Command("systemd-run", "--user", "--collect", "--unit="+unit,
		"-p", "KillMode=mixed",
		"--setenv=SWITCHBOARD_HOME="+home, "--setenv=KEEPER_TEST_CHILD=1",
		os.Args[0], "keeper-proc").CombinedOutput()
	if err != nil {
		t.Fatalf("systemd-run: %v: %s", err, out)
	}
	t.Cleanup(func() { exec.Command("systemctl", "--user", "stop", unit).Run() })
	pid := 0
	eventually(t, "MainPID службы", func() bool {
		b, _ := exec.Command("systemctl", "--user", "show", "-p", "MainPID", "--value", unit).Output()
		pid, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		return pid > 0
	})
	return pid
}
