//go:build linux

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

// Linux: systemd --user и linger — стартует без входа. Restart=always поднимает вышедший keeper (и после подмены себя) раз в секунду без предела, как служба
// Windows: по умолчанию systemd сдаётся после 5 запусков за 10 с (wsl 1 нояб.). KillMode=process: остановка и перезапуск трогают только keeper — держатели и их
// процессы живут (замер 1 нояб.).
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
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(h, ".config")
	}
	return filepath.Join(dir, "systemd", "user", serviceName()+".service"), nil
}

func install(args []string) error {
	f, err := parseInstall(args)
	if err != nil {
		return err
	}
	if err := prepareConf(f, bufio.NewReader(os.Stdin)); err != nil {
		return err
	}
	exe, err := placeSelf()
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
		// установка поверх работающей службы — перезапуск с новым юнитом и файлом; держатели живут (KillMode=process)
		{"systemctl", "--user", "restart", serviceName() + ".service"},
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
	if out, err := exec.Command("systemctl", "--user", "disable", "--now", serviceName()+".service").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl disable: %v: %s", err, out)
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return exec.Command("systemctl", "--user", "daemon-reload").Run()
}
