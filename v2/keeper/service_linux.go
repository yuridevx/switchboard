package main

// Служба Linux: юнит systemd --user этого флота; linger — служба живёт без входа пользователя. KillMode=process — при остановке и перезапуске
// службы держатели и их процессы живут. Установка поверх своего юнита — перезапуск с новым юнитом и файлом.
import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

func unitPath() (string, error) {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		u, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(u, ".config")
	}
	return filepath.Join(dir, "systemd", "user", serviceName()+".service"), nil
}

func systemctl(args ...string) error {
	out, err := exec.Command("systemctl", append([]string{"--user"}, args...)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl --user %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func registered() error { return nil }

func register(dst string, _ bool, _ *bufio.Reader) error {
	path, err := unitPath()
	if err != nil {
		return err
	}
	unit := fmt.Sprintf("[Unit]\nDescription=Switchboard keeper\nStartLimitIntervalSec=0\n\n[Service]\nExecStart=%q %s\nRestart=always\nRestartSec=1\nKillMode=process\n\n[Install]\nWantedBy=default.target\n",
		dst, strings.Join(runArgs(), " "))
	if err := writeFile(path, []byte(unit)); err != nil {
		return err
	}
	unitName := serviceName() + ".service"
	for _, a := range [][]string{{"daemon-reload"}, {"enable", unitName}, {"restart", unitName}} {
		if err := systemctl(a...); err != nil {
			return err
		}
	}
	u, err := user.Current()
	if err != nil {
		return err
	}
	if out, err := exec.Command("loginctl", "enable-linger", u.Username).CombinedOutput(); err != nil {
		return fmt.Errorf("loginctl enable-linger %s: %v: %s", u.Username, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func unregister() error {
	path, err := unitPath()
	if err != nil {
		return err
	}
	if err := systemctl("disable", "--now", serviceName()+".service"); err != nil {
		return err
	}
	os.Remove(path)
	return systemctl("daemon-reload")
}

func asService() bool { return false }
func runService() int { return 1 }
func hideConsole()    {}
