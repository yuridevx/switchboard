//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
)

func isService() bool { return false }
func runService()     {}

// Linux: systemd --user и linger — стартует без входа. Restart=always поднимает упавший keeper;
// KillMode=mixed: stop шлёт SIGTERM только keeper (штатная остановка), остаток cgroup — SIGKILL.
const unitText = `[Unit]
Description=Switchboard keeper

[Service]
ExecStart="%s" run
Restart=always
KillMode=mixed

[Install]
WantedBy=default.target
`

func unitPath() (string, error) {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(h, ".config")
	}
	return filepath.Join(dir, "systemd", "user", serviceName+".service"), nil
}

func install(args []string) error {
	if err := prepareConf(args); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	p, err := unitPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p, []byte(fmt.Sprintf(unitText, exe)), 0o644); err != nil {
		return err
	}
	u, err := user.Current()
	if err != nil {
		return err
	}
	for _, c := range [][]string{
		{"systemctl", "--user", "daemon-reload"},
		{"systemctl", "--user", "enable", "--now", serviceName + ".service"},
		{"loginctl", "enable-linger", u.Username},
	} {
		if out, err := exec.Command(c[0], c[1:]...).CombinedOutput(); err != nil {
			return fmt.Errorf("%v: %v: %s", c, err, out)
		}
	}
	return nil
}

func uninstall() error {
	p, err := unitPath()
	if err != nil {
		return err
	}
	if out, err := exec.Command("systemctl", "--user", "disable", "--now", serviceName+".service").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl disable: %v: %s", err, out)
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return exec.Command("systemctl", "--user", "daemon-reload").Run()
}
