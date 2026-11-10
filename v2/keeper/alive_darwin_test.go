package main

import "syscall"

// alive — процесс с этим номером жив (macOS: без /proc — только сигнал 0).
func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }
