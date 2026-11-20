package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// alive — процесс с этим номером жив; зомби — мёртв.
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	f := strings.Fields(string(b[strings.LastIndexByte(string(b), ')')+1:]))
	return len(f) > 0 && f[0] != "Z"
}

// waitGone — дождаться выхода процесса, и не своего потомка: pidfd становится читаемым, когда процесс вышел.
func waitGone(pid int) {
	fd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		return // процесса нет
	}
	defer unix.Close(fd)
	fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	for {
		if _, err := unix.Poll(fds, -1); err != unix.EINTR {
			return
		}
	}
}
