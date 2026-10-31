//go:build windows

package main

import (
	"os"
	"os/exec"
	"testing"
)

// startKeeperProc — keeper отдельным процессом в консольном режиме.
func startKeeperProc(t *testing.T, home string) int {
	cmd := exec.Command(os.Args[0], "keeper-proc")
	cmd.Env = append(os.Environ(), "SWITCHBOARD_HOME="+home)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go cmd.Wait()
	t.Cleanup(func() { cmd.Process.Kill() })
	return cmd.Process.Pid
}
