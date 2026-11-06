package main

// Установка машины: keeper install [--worker <имя>=<https://…>]… [--logon] [--name <имя>]. Приглашение машины — первой строкой stdin, у
// службы Windows пароль пользователя — второй; секреты не в аргументах. gate.redeem → machine.key; keeper.json — node из PATH и адреса
// Worker'ов; файл keeper — в папке флота; служба ОС этого флота. Отказ — словом, на диске и в ОС ничего не меняется.
import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// redeemWait — ответ gate на приглашение: gate гасит приглашение до ответа, опоздавший ответ — потерянное приглашение.
const redeemWait = 30 * time.Second

type installFlags struct {
	workers map[string]string
	logon   bool
}

// workerFlags — --worker <имя>=<адрес>, сколько угодно раз.
type workerFlags map[string]string

func (w workerFlags) String() string { return "" }

func (w workerFlags) Set(s string) error {
	name, url, ok := strings.Cut(s, "=")
	if !ok || name == "" || !strings.HasPrefix(url, "http") {
		return fmt.Errorf("--worker <имя>=<https://…>, а не %q", s)
	}
	w[name] = url
	return nil
}

func parseInstall(args []string) (installFlags, error) {
	f := installFlags{workers: workerFlags{}}
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Var(workerFlags(f.workers), "worker", "")
	fs.BoolVar(&f.logon, "logon", false, "")
	if err := fs.Parse(args); err != nil {
		return f, err
	}
	if fs.NArg() > 0 {
		return f, fmt.Errorf("незнакомый аргумент %q", fs.Arg(0))
	}
	return f, nil
}

// install — машина во флоте: занятое имя службы — отказ до приглашения; затем пропуск, keeper.json, файл keeper и служба ОС.
func install(args []string) error {
	f, err := parseInstall(args)
	if err != nil {
		return err
	}
	if err := registered(); err != nil {
		return err
	}
	in := bufio.NewReader(os.Stdin)
	if err := prepareConf(f, in); err != nil {
		return err
	}
	dst, err := placeSelf()
	if err != nil {
		return err
	}
	return register(dst, f.logon, in)
}

// prepareConf — приглашение принято gate: machine.key и keeper.json в папке флота.
func prepareConf(f installFlags, in *bufio.Reader) error {
	home, err := homeDir()
	if err != nil {
		return err
	}
	c, err := readConf(home)
	if err != nil {
		return fmt.Errorf("keeper.json не прочитан: %w", err)
	}
	if c.Workers == nil {
		c.Workers = map[string]string{}
	}
	for n, u := range f.workers {
		c.Workers[n] = u
	}
	if c.Workers["gate"] == "" {
		return errors.New("нет адреса gate: --worker gate=https://…")
	}
	if c.Node == "" {
		node, err := exec.LookPath("node")
		if err != nil {
			return fmt.Errorf("node не найден в PATH: %w", err)
		}
		c.Node, _ = filepath.Abs(node)
	}
	invite, err := readLine(in)
	if err != nil || invite == "" {
		return fmt.Errorf("приглашение машины — первой строкой stdin: нет строки в stdin: %v", err)
	}
	var r struct {
		OK     bool
		Error  string
		Result struct{ Key string }
	}
	ctx, cancel := context.WithTimeout(context.Background(), redeemWait)
	defer cancel()
	if err := postWorker(ctx, c.Workers["gate"], "", map[string]any{"type": "gate.redeem", "id": "install", "v": 1, "invite": invite}, &r); err != nil {
		return fmt.Errorf("приглашение не принято: %w", err)
	}
	if !r.OK {
		return fmt.Errorf("приглашение не принято: %s", r.Error)
	}
	if p := strings.Split(r.Result.Key, "."); len(p) != 4 || p[0] != "host" {
		return fmt.Errorf("приглашение не машины: пропуск %s", strings.Join(p[:min(3, len(p))], "."))
	}
	if c.Workers["relay"] == "" {
		fmt.Fprintln(os.Stderr, "install: в keeper.json нет адреса relay — keeper будет исполнять сохранённый план без связи (--worker relay=https://…)")
	}
	if err := writeFile(filepath.Join(home, "machine.key"), []byte(r.Result.Key+"\n")); err != nil {
		return err
	}
	return c.write(home)
}

// readLine — строка stdin без перевода строки.
func readLine(in *bufio.Reader) (string, error) {
	l, err := in.ReadString('\n')
	if err == io.EOF && l != "" {
		err = nil
	}
	return strings.TrimRight(l, "\r\n"), err
}

// placeSelf — файл keeper в папке флота: его запускает служба и его подменяет keeper.
func placeSelf() (string, error) {
	home, err := homeDir()
	if err != nil {
		return "", err
	}
	me, err := os.Executable()
	if err != nil {
		return "", err
	}
	dst := filepath.Join(home, exe("keeper"))
	if a, b := fileStat(me), fileStat(dst); a != nil && b != nil && os.SameFile(a, b) {
		return dst, nil
	}
	os.MkdirAll(home, 0o700)
	return dst, replace(dst, me)
}

func fileStat(p string) os.FileInfo { s, _ := os.Stat(p); return s }
