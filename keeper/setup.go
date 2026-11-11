package main

// Установка машины: keeper install --base <https://адрес флота> [--name <флот>]. Приглашение машины — первой строкой stdin, у
// службы Windows пароль пользователя — второй; секреты не в аргументах. Флот — из приглашения (флот:номер:секрет); redeem → machine.key;
// keeper.json — адрес флота, имя машины из ответа и node из PATH; файл keeper — в папке флота; служба ОС этого флота.
// Отказ — словом, на диске и в ОС ничего не меняется.
import (
	"bufio"
	"context"
	"encoding/json"
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

// redeemWait — ответ флота на приглашение: приглашение гасится до ответа, опоздавший ответ — потерянное приглашение.
const redeemWait = 30 * time.Second

type installFlags struct {
	base string
}

func parseInstall(args []string) (installFlags, error) {
	var f installFlags
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&f.base, "base", "", "")
	if err := fs.Parse(args); err != nil {
		return f, err
	}
	if fs.NArg() > 0 {
		return f, fmt.Errorf("незнакомый аргумент %q", fs.Arg(0))
	}
	if !strings.HasPrefix(f.base, "https://") && !strings.HasPrefix(f.base, "http://") {
		return f, errors.New("нужен адрес флота: --base https://…")
	}
	return f, nil
}

// install — машина во флоте: флот из приглашения; занятое имя службы — отказ до приёма приглашения; затем пропуск, keeper.json, файл
// keeper и служба ОС.
func install(args []string) error {
	f, err := parseInstall(args)
	if err != nil {
		return err
	}
	in := bufio.NewReader(os.Stdin)
	invite, err := readInvite(in)
	if err != nil {
		return err
	}
	if err := registered(); err != nil {
		return err
	}
	if err := prepareConf(f, invite); err != nil {
		return err
	}
	dst, err := placeSelf()
	if err != nil {
		return err
	}
	return register(dst, in)
}

// readInvite — приглашение первой строкой stdin; его флот становится флотом этой службы (с --name — должен совпасть).
func readInvite(in *bufio.Reader) (string, error) {
	invite, err := readLine(in)
	if err != nil || invite == "" {
		return "", fmt.Errorf("приглашение машины — первой строкой stdin: нет строки в stdin: %v", err)
	}
	fleet := passFleet(invite)
	if fleet == "" {
		return "", errors.New("приглашение не вида флот:номер:секрет")
	}
	if fleetName != "" && fleetName != fleet {
		return "", fmt.Errorf("приглашение флота %s, а --name %s", fleet, fleetName)
	}
	fleetName = fleet
	return invite, nil
}

// prepareConf — приглашение принято флотом: machine.key и keeper.json в папке флота.
func prepareConf(f installFlags, invite string) error {
	home, err := homeDir()
	if err != nil {
		return err
	}
	c, err := readConf(home)
	if err != nil {
		return fmt.Errorf("keeper.json не прочитан: %w", err)
	}
	c.Base = strings.TrimSuffix(f.base, "/")
	if c.Node == "" {
		node, err := exec.LookPath("node")
		if err != nil {
			return fmt.Errorf("node не найден в PATH: %w", err)
		}
		c.Node, _ = filepath.Abs(node)
	}
	var r reply
	ctx, cancel := context.WithTimeout(context.Background(), redeemWait)
	defer cancel()
	if err := postCall(ctx, c.Base, "", map[string]any{"type": "redeem", "id": "r" + newID(), "trace": "t" + newID(), "invite": invite}, &r); err != nil {
		return fmt.Errorf("приглашение не принято: %w", err)
	}
	if !r.OK {
		return fmt.Errorf("приглашение не принято: %s %s", r.Error, r.Why)
	}
	var res struct{ Key, Addr string }
	if err := json.Unmarshal(r.Result, &res); err != nil {
		return fmt.Errorf("приглашение не принято: ответ не разобран: %w", err)
	}
	machine, ok := strings.CutPrefix(res.Addr, "@")
	if !ok || !simpleName(machine) || strings.Contains(machine, "~") {
		return fmt.Errorf("приглашение не машины: пропуск выдан адресу %s", res.Addr)
	}
	if passFleet(res.Key) != fleetName {
		return fmt.Errorf("пропуск не флота %s", fleetName)
	}
	c.Machine = machine
	if err := writeFile(filepath.Join(home, "machine.key"), []byte(res.Key+"\n")); err != nil {
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
