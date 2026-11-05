package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

func isService() bool { return false }
func runService()     {}
func hideConsole()    {}

// checkFree — установка поверх своей службы законна: юнит переписан, служба перезапущена, держатели живут.
func checkFree() error { return nil }

// unit — systemd --user с linger: стартует без входа. Restart=always поднимает вышедший keeper (и после подмены себя) раз в секунду без предела: по умолчанию
// systemd сдаётся после 5 запусков за 10 с (wsl 1 нояб.). KillMode=process: остановка и перезапуск трогают только keeper (замер 1 нояб.).
const unit = `[Unit]
Description=Switchboard keeper
StartLimitIntervalSec=0

[Service]
ExecStart="%s" %s
Restart=always
RestartSec=1
KillMode=process

[Install]
WantedBy=default.target
`

func unitPath() (string, error) {
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "systemd", "user", serviceName()+".service"), nil
}

func run(name string, args ...string) error {
	if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, out)
	}
	return nil
}

func register(exe string, _ bool, _ *bufio.Reader) error {
	p, err := unitPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p, []byte(fmt.Sprintf(unit, exe, strings.Join(runArgs(), " "))), 0o644); err != nil {
		return err
	}
	u, err := user.Current()
	if err != nil {
		return err
	}
	for _, c := range [][]string{
		{"systemctl", "--user", "daemon-reload"},
		{"systemctl", "--user", "enable", serviceName() + ".service"},
		{"systemctl", "--user", "restart", serviceName() + ".service"},
		{"loginctl", "enable-linger", u.Username},
	} {
		if err := run(c[0], c[1:]...); err != nil {
			return err
		}
	}
	return nil
}

func unregister() error {
	p, err := unitPath()
	if err != nil {
		return err
	}
	if err := run("systemctl", "--user", "disable", "--now", serviceName()+".service"); err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return run("systemctl", "--user", "daemon-reload")
}
