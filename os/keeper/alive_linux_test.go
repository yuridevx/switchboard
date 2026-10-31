//go:build linux

package main

import (
	"os"
	"strconv"
	"strings"
)

// alive — процесс с этим pid ещё работает (зомби — уже нет).
func alive(pid int) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	return i < 0 || i+2 >= len(s) || s[i+2] != 'Z'
}
