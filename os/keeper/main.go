// keeper — служба ОС Switchboard: исполнитель плана машины. Держит части машины (Host и приложения) через держатели,
// отвечает keeper.state, подменяет себя по плану.
//
//	keeper run [--hide]   — в консоли; Ctrl+C — штатная остановка keeper (держатели и их процессы живут)
//	keeper install        — ключ машины (host.<машина>…, из него и имя машины) — первой строкой stdin; флаг --relay;
//	                        Windows: служба под пользователем (пароль — второй строкой stdin) или --logon — задача
//	                        «при входе пользователя» с повтором раз в минуту; Linux — systemd --user с linger
//	keeper uninstall      — убрать службу или задачу
//	keeper hold …         — режим держателя (запускают keeper и Host)
//	keeper version        — версия
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
		os.Exit(runConsole(os.Args[2:]))
	case "hold":
		os.Exit(runHold(os.Args[2:]))
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
		fmt.Fprintln(os.Stderr, "keeper "+keeperVersion+": run [--hide] | install [--relay <wss>] [--logon] | uninstall | hold … | version")
		os.Exit(2)
	}
}

// runConsole — keeper в консоли; SIGINT или SIGTERM — штатная остановка.
func runConsole(args []string) int {
	for _, a := range args {
		if a == "--hide" {
			hideConsole()
		}
	}
	home, err := homeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper:", err)
		return 1
	}
	if self, err := os.Executable(); err == nil {
		cleanupOldSelf(self)
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
		return k.exitCode
	}
}

// installFlags — флаги установки.
type installFlags struct {
	relay string
	logon bool
}

func parseInstall(args []string) (installFlags, error) {
	var f installFlags
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.StringVar(&f.relay, "relay", "", "адрес relay (wss://…)")
	fs.BoolVar(&f.logon, "logon", false, "Windows: задача «при входе пользователя» вместо службы")
	return f, fs.Parse(args)
}

// prepareConf — keeper.json (node, relay) и ключ машины machine.key из первой строки stdin: им входят Host и keeper,
// из него же — имя машины.
func prepareConf(f installFlags, in *bufio.Reader) error {
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
	if f.relay != "" {
		m["relay"] = f.relay
	}
	key, err := readSecretLine(in)
	if err != nil {
		return fmt.Errorf("ключ машины — первой строкой stdin: %w", err)
	}
	if !strings.HasPrefix(key, "host.") {
		return fmt.Errorf("ключ не машины: нужен host.<машина>…")
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(home, "machine.key"), []byte(key+"\n"), 0o600); err != nil {
		return err
	}
	if confStr(m, "relay") == "" {
		fmt.Fprintln(os.Stderr, "install: в keeper.json нет relay — keeper будет исполнять сохранённый план без связи (--relay)")
	}
	return writeConf(home, m)
}

// readSecretLine — одна строка из stdin: не из аргументов.
func readSecretLine(in *bufio.Reader) (string, error) {
	s, err := in.ReadString('\n')
	if err != nil && s == "" {
		return "", fmt.Errorf("нет строки в stdin: %w", err)
	}
	return strings.TrimRight(s, "\r\n"), nil
}

// placeSelf — файл keeper на постоянное место ~/.switchboard/keeper(.exe): его запускают служба или задача,
// самообновление ставит новый файл туда же. Прежний файл на месте переименовывается: запущенный не удалить.
func placeSelf() (string, error) {
	home, err := homeDir()
	if err != nil {
		return "", err
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dst := filepath.Join(home, exeName("keeper"))
	a, errA := os.Stat(exe)
	b, errB := os.Stat(dst)
	if errA == nil && errB == nil && os.SameFile(a, b) {
		return dst, nil
	}
	if errB == nil {
		old := dst + ".prev.old"
		os.Remove(old)
		if err := os.Rename(dst, old); err != nil {
			return "", fmt.Errorf("прежний файл keeper занят: %w", err)
		}
	}
	return dst, copyFile(exe, dst)
}
