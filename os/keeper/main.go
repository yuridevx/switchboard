// keeper — служба ОС машины: исполняет план машины от «Выпусков» — ставит части, держит их процессы через держатели, подменяет себя.
// Сам ничего не решает. Тот же файл в режиме hold — держатель одного процесса: им пользуются keeper для частей и Host для сессий.
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

//go:embed module.json
var manifest []byte

const usage = "keeper: run [--hide] | install [--worker <имя>=<https>]… [--logon] | uninstall | hold … | version; у run, install, uninstall — [--name <имя>]"

// version — номер выпуска из module.json, встроенного в файл.
func version() string {
	var m struct{ Version string }
	json.Unmarshal(manifest, &m)
	return m.Version
}

func osName() string { return runtime.GOOS + " " + runtime.GOARCH }

// fleetName — имя флота: пусто — первый флот компьютера.
var fleetName string

// useName — снять --name <имя> с аргументов: у второго флота своя служба и своя папка.
func useName(args []string) ([]string, error) {
	var rest []string
	for i := 0; i < len(args); i++ {
		if args[i] != "--name" {
			rest = append(rest, args[i])
			continue
		}
		if i+1 >= len(args) || !simpleName(args[i+1]) {
			return nil, errors.New("--name <имя> — без путей")
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

func serviceName() string { return suffixed("switchboard-keeper") }

func suffixed(s string) string {
	if fleetName == "" {
		return s
	}
	return s + "-" + fleetName
}

// runArgs — команда, которой ОС поднимает keeper этого флота.
func runArgs() []string {
	if fleetName == "" {
		return []string{"run"}
	}
	return []string{"run", "--name", fleetName}
}

// homeDir — папка машины: у флота с именем — ~/.switchboard-<имя>; без имени — SWITCHBOARD_HOME или ~/.switchboard.
func homeDir() (string, error) {
	if h := os.Getenv("SWITCHBOARD_HOME"); h != "" && fleetName == "" {
		return h, nil
	}
	u, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(u, suffixed(".switchboard")), nil
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
		fmt.Println(version())
	case "hold":
		os.Exit(runHold(args))
	case "run":
		os.Exit(runFleet(args))
	case "install":
		err = install(args)
	case "uninstall":
		err = unregister()
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
