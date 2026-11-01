//go:build linux

package main

import (
	"os"
	"strings"
	"syscall"
	"testing"
)

// alive — процесс жив и не зомби.
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	b, err := os.ReadFile("/proc/" + itoa(pid) + "/stat")
	return err == nil && !strings.Contains(string(b), ") Z ")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

func killPid(t *testing.T, pid int) {
	t.Helper()
	syscall.Kill(pid, syscall.SIGKILL)
}
