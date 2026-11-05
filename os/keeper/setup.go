package main

// Установка машины: keeper install [--worker <имя>=<https://…>]… [--logon] [--name <имя>]. Приглашение машины — первой строкой stdin, у
// службы Windows пароль пользователя — второй; секреты не в аргументах. gate.redeem → machine.key; keeper.json — node из PATH и адреса
// Worker'ов; файл keeper — в папке флота; служба ОС этого флота. Отказ — словом, на диске и в ОС ничего не меняется.
import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type installFlags struct {
	workers map[string]string
	logon   bool
}

func parseInstall(args []string) (installFlags, error) {
	f := installFlags{workers: map[string]string{}}
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--logon":
			f.logon = true
		case a == "--worker" && i+1 < len(args):
			i++
			name, url, ok := strings.Cut(args[i], "=")
			if !ok || name == "" || !strings.HasPrefix(url, "http") {
				return f, fmt.Errorf("--worker <имя>=<https://…>, а не %q", args[i])
			}
			f.workers[name] = url
		default:
			return f, fmt.Errorf("незнакомый аргумент %q", a)
		}
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
	invite, err := readLine(in)
	if err != nil || invite == "" {
		return fmt.Errorf("приглашение машины — первой строкой stdin: нет строки в stdin: %v", err)
	}
	var r struct {
		OK     bool
		Error  string
		Result struct{ Key string }
	}
	ctx, cancel := context.WithTimeout(context.Background(), callWait)
	defer cancel()
	if err := postWorker(ctx, c.Workers["gate"], "", map[string]any{"type": "gate.redeem", "id": "install", "invite": invite}, &r); err != nil {
		return fmt.Errorf("приглашение не принято: %w", err)
	}
	if !r.OK {
		return fmt.Errorf("приглашение не принято: %s", r.Error)
	}
	if p := strings.Split(r.Result.Key, "."); len(p) != 4 || p[0] != "host" {
		return fmt.Errorf("приглашение не машины: пропуск %s", strings.Join(p[:min(3, len(p))], "."))
	}
	if node, err := exec.LookPath("node"); err == nil {
		c.Node, _ = filepath.Abs(node)
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
	return dst, copyFile(dst, me)
}

func fileStat(p string) os.FileInfo { s, _ := os.Stat(p); return s }
