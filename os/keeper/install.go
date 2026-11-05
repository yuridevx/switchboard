package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"switchboard/keeper/internal/machine"
)

const redeemWait = 30 * time.Second

type installFlags struct {
	workers workerFlag
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
	f := installFlags{workers: workerFlag{}}
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.Var(f.workers, "worker", "адрес Worker'а флота <имя>=<https://…>: relay, gate, releases, ledger")
	fs.BoolVar(&f.logon, "logon", false, "Windows: задача «при входе пользователя» вместо службы")
	return f, fs.Parse(args)
}

func install(args []string) error {
	f, err := parseInstall(args)
	if err != nil {
		return err
	}
	// второй вид установки поверх первого — два keeper на одних держателях: отказ до правки файлов
	if err := checkFree(); err != nil {
		return err
	}
	in := bufio.NewReader(os.Stdin)
	if err := prepareConf(f, in); err != nil {
		return err
	}
	exe, err := placeSelf()
	if err != nil {
		return err
	}
	return register(exe, f.logon, in)
}

// prepareConf — keeper.json (node, workers, незнакомые поля целы) и пропуск machine.key: приглашение — первой строкой stdin, keeper принимает его у gate;
// погашенное или чужое — отказ словом, ничего не записано.
func prepareConf(f installFlags, in *bufio.Reader) error {
	home, err := machine.Home()
	if err != nil {
		return err
	}
	conf := map[string]any{}
	if b, err := os.ReadFile(filepath.Join(home, "keeper.json")); err == nil {
		if err := json.Unmarshal(b, &conf); err != nil {
			return fmt.Errorf("keeper.json не прочитан: %w", err)
		}
	}
	if conf["node"] == nil || conf["node"] == "" {
		node, err := exec.LookPath("node")
		if err != nil {
			return fmt.Errorf("node не найден в PATH: %w", err)
		}
		if node, err = filepath.Abs(node); err != nil {
			return err
		}
		conf["node"] = node
	}
	workers, _ := conf["workers"].(map[string]any)
	if workers == nil {
		workers = map[string]any{}
	}
	for name, url := range f.workers {
		workers[name] = url
	}
	conf["workers"] = workers
	invite, err := readLine(in)
	if err != nil {
		return fmt.Errorf("приглашение машины — первой строкой stdin: %w", err)
	}
	gate, _ := workers["gate"].(string)
	if gate == "" {
		return errors.New("нет адреса gate: --worker gate=https://…")
	}
	key, err := redeem(gate, invite)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	if err := machine.WriteAtomic(filepath.Join(home, "machine.key"), []byte(key+"\n")); err != nil {
		return err
	}
	if workers["relay"] == nil {
		fmt.Fprintln(os.Stderr, "install: в keeper.json нет адреса relay — keeper будет исполнять сохранённый план без связи (--worker relay=https://…)")
	}
	b, _ := json.MarshalIndent(conf, "", "  ")
	return machine.WriteAtomic(filepath.Join(home, "keeper.json"), append(b, '\n'))
}

// readLine — одна строка из stdin: секреты не идут через аргументы.
func readLine(in *bufio.Reader) (string, error) {
	s, err := in.ReadString('\n')
	if err != nil && s == "" {
		return "", fmt.Errorf("нет строки в stdin: %w", err)
	}
	return strings.TrimRight(s, "\r\n"), nil
}

// redeem — gate.redeem: пропуск только машины; секрет пропуска в сообщение не идёт.
func redeem(gate, invite string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), redeemWait)
	defer cancel()
	var r struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Result struct {
			Key string `json:"key"`
		} `json:"result"`
	}
	if err := machine.Post(ctx, gate, map[string]any{"type": "gate.redeem", "id": "install", "v": 1, "invite": invite}, &r); err != nil {
		return "", fmt.Errorf("приглашение не принято: %w", err)
	}
	if !r.OK {
		return "", fmt.Errorf("приглашение не принято: %s", r.Error)
	}
	if !strings.HasPrefix(r.Result.Key, "host.") {
		p := strings.SplitN(r.Result.Key, ".", 4)
		return "", fmt.Errorf("приглашение не машины: пропуск %s", strings.Join(p[:min(3, len(p))], "."))
	}
	return r.Result.Key, nil
}

// placeSelf — файл keeper на постоянное место в папке машины: его запускают служба или задача, подмена себя ставит новый файл туда же.
func placeSelf() (string, error) {
	home, err := machine.Home()
	if err != nil {
		return "", err
	}
	name := "keeper"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	dst := filepath.Join(home, name)
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	a, errA := os.Stat(self)
	b, errB := os.Stat(dst)
	if errA == nil && errB == nil && os.SameFile(a, b) {
		return dst, nil
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", err
	}
	return dst, machine.Swap(self, dst, fmt.Sprintf("%s.prev.%d.old", dst, os.Getpid()))
}
