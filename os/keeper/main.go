// keeper — служба ОС Switchboard: исполнитель плана машины. Держит части машины (Host и приложения) через держатели,
// отвечает keeper.state, подменяет себя по плану.
//
//	keeper run [--hide]   — в консоли; Ctrl+C — штатная остановка keeper (держатели и их процессы живут)
//	keeper install        — приглашение машины — первой строкой stdin: keeper принимает его у gate (--worker gate=…)
//	                        и кладёт пропуск в machine.key; --worker <имя>=<https> — адреса в keeper.json (relay, gate,
//	                        releases, ledger; relay — объект своей машины);
//	                        Windows: служба под пользователем (пароль — второй строкой stdin) или --logon — задача
//	                        «при входе пользователя» с повтором раз в минуту; Linux — systemd --user с linger
//	keeper uninstall      — убрать службу или задачу
//	keeper hold …         — режим держателя (запускают keeper и Host)
//	keeper version        — версия
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
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
		fmt.Fprintln(os.Stderr, "keeper "+keeperVersion+": run [--hide] | install [--worker <имя>=<https>]… [--logon] | uninstall | hold … | version")
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
		// keeper остановился сам — только после подмены себя: ОС поднимет новый файл
		return 3
	}
}

// installFlags — флаги установки.
type installFlags struct {
	workers map[string]string
	logon   bool
}

// workerFlag — --worker <имя>=<https>, сколько угодно раз.
type workerFlag map[string]string

func (w workerFlag) String() string { return "" }
func (w workerFlag) Set(v string) error {
	name, url, ok := strings.Cut(v, "=")
	if !ok || name == "" || !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return fmt.Errorf("--worker <имя>=<https://…>, а не %q", v)
	}
	w[name] = url
	return nil
}

func parseInstall(args []string) (installFlags, error) {
	f := installFlags{workers: map[string]string{}}
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.Var(workerFlag(f.workers), "worker", "адрес Worker'а флота <имя>=<https://…>: relay, gate, releases, ledger")
	fs.BoolVar(&f.logon, "logon", false, "Windows: задача «при входе пользователя» вместо службы")
	return f, fs.Parse(args)
}

// prepareConf — keeper.json (node, workers) и пропуск машины machine.key: приглашение — первой строкой stdin,
// keeper принимает его у gate (POST gate.redeem); погашенное или чужое — отказ словом, machine.key не тронут.
// Пропуском входят Host и keeper, из него же — имя машины.
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
	workers := confMap(m, "workers")
	for k, v := range f.workers {
		workers[k] = v
	}
	if len(workers) > 0 {
		m["workers"] = workers
	}
	invite, err := readSecretLine(in)
	if err != nil {
		return fmt.Errorf("приглашение машины — первой строкой stdin: %w", err)
	}
	if workers["gate"] == "" {
		return fmt.Errorf("нет адреса gate: --worker gate=https://…")
	}
	r := post(workers["gate"], "", frameMsg{"type": "gate.redeem", "id": "install", "v": 1, "invite": invite}, 30*time.Second, nil)
	if !r.OK {
		return fmt.Errorf("приглашение не принято: %s", r.Error)
	}
	var got struct{ Key string }
	json.Unmarshal(r.Result, &got)
	key := got.Key
	if !strings.HasPrefix(key, "host.") {
		return fmt.Errorf("приглашение не машины: пропуск %s", strings.Join(strings.SplitN(key, ".", 4)[:min(3, len(strings.SplitN(key, ".", 4)))], "."))
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(home, "machine.key"), []byte(key+"\n"), 0o600); err != nil {
		return err
	}
	if workers["relay"] == "" {
		fmt.Fprintln(os.Stderr, "install: в keeper.json нет адреса relay — keeper будет исполнять сохранённый план без связи (--worker relay=https://…)")
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
// самообновление ставит новый файл туда же. Прежний файл на месте уходит в .old с новым именем: запущенный не удалить.
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
	return dst, replaceFile(exe, dst, fmt.Sprintf("%s.prev.%d.old", dst, os.Getpid()))
}
