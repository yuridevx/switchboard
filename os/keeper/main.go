// keeper — служба ОС Switchboard без логики: держит процессы claude, запускает и обновляет Host.
//
//	keeper run        — в консоли (отладка); Ctrl+C — штатная остановка
//	keeper install    — служба: Windows — служба под пользователем (пароль — одной строкой в stdin),
//	                    Linux — systemd --user с linger; флаги --host <версия>, --machine <имя>
//	keeper uninstall  — убрать службу
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

const serviceName = "switchboard-keeper"

func main() {
	if isService() {
		runService()
		return
	}
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "run":
		os.Exit(runConsole())
	case "install":
		if err := install(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "install:", err)
			os.Exit(1)
		}
	case "uninstall":
		if err := uninstall(); err != nil {
			fmt.Fprintln(os.Stderr, "uninstall:", err)
			os.Exit(1)
		}
	case "version":
		fmt.Println(keeperVersion)
	default:
		fmt.Fprintln(os.Stderr, "keeper "+keeperVersion+": run | install [--host <версия>] [--machine <имя>] | uninstall | version")
		os.Exit(2)
	}
}

// runConsole — keeper в консоли; SIGINT или SIGTERM — штатная остановка.
func runConsole() int {
	home, err := homeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper:", err)
		return 1
	}
	k, err := Start(home, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper:", err)
		return 1
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
		k.Stop()
		return 0
	case <-k.Done():
		return 1
	}
}

// prepareConf — установщик пишет в keeper.json node (если его нет), версию Host и имя машины.
func prepareConf(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	host := fs.String("host", "", "версия Host из ~/.switchboard/host/")
	machine := fs.String("machine", "", "имя машины для журнала")
	if err := fs.Parse(args); err != nil {
		return err
	}
	home, err := homeDir()
	if err != nil {
		return err
	}
	m, err := readConf(home)
	if err != nil {
		return err
	}
	if confStr(m, "node") == "" {
		node, err := exec.LookPath("node")
		if err != nil {
			return fmt.Errorf("node не найден в PATH: %w", err)
		}
		if node, err = filepath.Abs(node); err != nil {
			return err
		}
		m["node"] = node
	}
	if *host != "" {
		m["host"] = *host
	}
	if *machine != "" {
		m["machine"] = *machine
	}
	if confStr(m, "host") == "" {
		fmt.Fprintln(os.Stderr, "install: в keeper.json нет версии Host — keeper не запустит Host, пока её нет (--host)")
	}
	return writeConf(home, m)
}

// readSecretLine — одна строка из stdin (пароль): не из аргументов.
func readSecretLine() (string, error) {
	s, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && s == "" {
		return "", fmt.Errorf("нет строки в stdin: %w", err)
	}
	return strings.TrimRight(s, "\r\n"), nil
}
