package main

// Подготовка машины — общая часть установки на всех ОС: keeper.json, пропуск machine.key, файл keeper на постоянном месте.
import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"switchboard/keeper/internal/link"
	"switchboard/keeper/internal/machine"
	"switchboard/keeper/internal/release"
)

// redeemWait — предел приёма приглашения у gate.
const redeemWait = 30 * time.Second

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

// prepareConf — keeper.json (node, workers) и пропуск machine.key: приглашение — первой строкой stdin, keeper принимает его у gate; погашенное или чужое —
// отказ словом, machine.key не тронут. Пропуском входят Host и keeper, из него же — имя машины.
func prepareConf(f installFlags, in *bufio.Reader) error {
	home, err := machine.Home()
	if err != nil {
		return err
	}
	c, err := machine.ReadConf(home)
	if err != nil {
		return err
	}
	if c.Node() == "" {
		node, err := exec.LookPath("node")
		if err != nil {
			return fmt.Errorf("node не найден в PATH: %w", err)
		}
		if node, err = filepath.Abs(node); err != nil {
			return err
		}
		c["node"] = node
	}
	workers := c.Workers()
	for name, url := range f.workers {
		workers[name] = url
	}
	if len(workers) > 0 {
		c["workers"] = workers
	}
	invite, err := readLine(in)
	if err != nil {
		return fmt.Errorf("приглашение машины — первой строкой stdin: %w", err)
	}
	if workers["gate"] == "" {
		return fmt.Errorf("нет адреса gate: --worker gate=https://…")
	}
	r := link.Post(context.Background(), workers["gate"], "", link.Frame{"type": "gate.redeem", "id": "install", "v": 1, "invite": invite}, redeemWait)
	if !r.OK {
		return fmt.Errorf("приглашение не принято: %s", r.Error)
	}
	var got struct{ Key string }
	json.Unmarshal(r.Result, &got)
	if !strings.HasPrefix(got.Key, "host.") {
		p := strings.SplitN(got.Key, ".", 4)
		return fmt.Errorf("приглашение не машины: пропуск %s", strings.Join(p[:min(3, len(p))], "."))
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(machine.KeyPath(home), []byte(got.Key+"\n"), 0o600); err != nil {
		return err
	}
	if workers["relay"] == "" {
		fmt.Fprintln(os.Stderr, "install: в keeper.json нет адреса relay — keeper будет исполнять сохранённый план без связи (--worker relay=https://…)")
	}
	return machine.WriteConf(home, c)
}

// readLine — одна строка из stdin: секреты не идут через аргументы.
func readLine(in *bufio.Reader) (string, error) {
	s, err := in.ReadString('\n')
	if err != nil && s == "" {
		return "", fmt.Errorf("нет строки в stdin: %w", err)
	}
	return strings.TrimRight(s, "\r\n"), nil
}

// placeSelf — файл keeper на постоянное место в папке машины: его запускают служба или задача, подмена себя ставит новый файл туда же. Прежний файл на месте
// уходит в .old с новым именем: запущенный не удалить.
func placeSelf() (string, error) {
	home, err := machine.Home()
	if err != nil {
		return "", err
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dst := filepath.Join(home, release.BinaryName("keeper"))
	a, errA := os.Stat(exe)
	b, errB := os.Stat(dst)
	if errA == nil && errB == nil && os.SameFile(a, b) {
		return dst, nil
	}
	return dst, release.Replace(exe, dst, fmt.Sprintf("%s.prev.%d.old", dst, os.Getpid()))
}
