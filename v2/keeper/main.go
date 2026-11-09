// keeper — служба ОС машины: держит Host названной сборки через держателя и подменяет себя. Сам ничего не решает: что ставить, говорит
// план флота. Тот же файл в режиме hold — держатель одного процесса: им пользуются Keeper для Host и Host для сессий.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

const usage = "keeper: run [--hide] | install --base <https://адрес флота> [--logon] | uninstall | hold … | version; у run и uninstall — --name <флот>"

// build — номер сборки: его ставит сборка (-ldflags "-X main.build=412"); у файла, собранного руками, — 0.
var build = "0"

func buildNumber() int { n, _ := strconv.Atoi(build); return n }

func osName() string { return runtime.GOOS + " " + runtime.GOARCH }

// fleetName — флот этой службы: из --name, при установке — из приглашения.
var fleetName string

// useName — снять --name <флот> с аргументов.
func useName(args []string) ([]string, error) {
	var rest []string
	for i := 0; i < len(args); i++ {
		if args[i] != "--name" {
			rest = append(rest, args[i])
			continue
		}
		if i+1 >= len(args) || !simpleName(args[i+1]) {
			return nil, errors.New("--name <флот> — без путей")
		}
		fleetName = args[i+1]
		i++
	}
	return rest, nil
}

// simpleName — имя годится в имя файла или папки: не пусто, без разделителей пути и без точки в начале.
func simpleName(s string) bool {
	return s != "" && !strings.ContainsAny(s, `/\:`) && !strings.HasPrefix(s, ".")
}

func serviceName() string { return "switchboard2-keeper-" + fleetName }

// runArgs — команда, которой ОС поднимает keeper этого флота.
func runArgs() []string { return []string{"run", "--name", fleetName} }

// homeDir — папка флота на машине: SB_HOME или ~/.switchboard2/<флот>.
func homeDir() (string, error) {
	if h := os.Getenv("SB_HOME"); h != "" {
		return h, nil
	}
	if fleetName == "" {
		return "", errors.New("какой флот: --name <флот>")
	}
	u, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(u, ".switchboard2", fleetName), nil
}

func main() {
	if len(os.Args) < 2 {
		fail(2, usage)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	if cmd != "hold" && cmd != "version" {
		if args, err = useName(args); err != nil {
			fail(1, cmd+": "+err.Error())
		}
	}
	switch cmd {
	case "version":
		fmt.Println(build)
	case "hold":
		os.Exit(runHold(args))
	case "run":
		os.Exit(runFleet(args))
	case "install":
		err = install(args)
	case "uninstall":
		if fleetName == "" {
			err = errors.New("какой флот: --name <флот>")
		} else {
			err = unregister()
		}
	default:
		fail(2, usage)
	}
	if err != nil {
		fail(1, cmd+": "+err.Error())
	}
}

func fail(code int, text string) {
	fmt.Fprintln(os.Stderr, text)
	os.Exit(code)
}

// runFleet — keeper этого флота до сигнала ОС или до подмены себя; служба Windows идёт через свой обработчик.
func runFleet(args []string) int {
	if asService() {
		return runService()
	}
	for _, a := range args {
		if a == "--hide" {
			hideConsole()
		}
	}
	k, err := startKeeper(Options{})
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper: "+err.Error())
		return 1
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
	select {
	case <-sig:
		k.Stop()
		return 0
	case <-k.Done():
		return exitUpdated
	}
}

// exitUpdated — код выхода после подмены себя: не ноль, чтобы ОС подняла новый файл.
const exitUpdated = 3

// startKeeper — keeper на папке этого флота.
func startKeeper(o Options) (*Keeper, error) {
	home, err := homeDir()
	if err != nil {
		return nil, err
	}
	k, err := newKeeper(home, o)
	if err != nil {
		return nil, err
	}
	k.Run()
	return k, nil
}
