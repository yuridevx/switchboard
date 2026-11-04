// keeper — служба ОС Switchboard: исполнитель плана машины. Держит части машины (Host и приложения) через держатели, отвечает keeper.state, подменяет себя
// по плану.
//
//	keeper run [--hide]   — в консоли; Ctrl+C — штатная остановка keeper (держатели и их процессы живут)
//	--name <имя>          — у run, install, uninstall: второй флот на этом компьютере — своя служба и своя папка
//	keeper install        — приглашение машины — первой строкой stdin: keeper принимает его у gate (--worker gate=…) и кладёт пропуск в machine.key;
//	                        --worker <имя>=<https> — адреса в keeper.json (relay, gate, releases, ledger; relay — объект своей машины);
//	                        Windows: служба под пользователем (пароль — второй строкой stdin) или --logon — задача «при входе пользователя» с повтором раз
//	                        в минуту; Linux — systemd --user с linger
//	keeper uninstall      — убрать службу или задачу
//	keeper hold …         — режим держателя (запускают keeper и Host)
//	keeper version        — версия
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"switchboard/keeper/internal/holder"
	"switchboard/keeper/internal/keeper"
	"switchboard/keeper/internal/machine"
)

//go:embed module.json
var manifest []byte

// buildVersion — номер выпуска: его ставит сборка -ldflags "-X main.buildVersion=…".
var buildVersion string

// version — номер выпуска или версия из module.json.
func version() string {
	if buildVersion != "" {
		return buildVersion
	}
	var m struct{ Version string }
	json.Unmarshal(manifest, &m)
	return m.Version
}

// fleetName — имя второго флота на компьютере; служба и папка выводятся из него.
var fleetName string

func serviceName() string {
	if fleetName == "" {
		return "switchboard-keeper"
	}
	return "switchboard-keeper-" + fleetName
}

// runArgs — команда службы и задачи: имя флота они несут в своей командной строке.
func runArgs() []string {
	if fleetName == "" {
		return []string{"run"}
	}
	return []string{"run", "--name", fleetName}
}

// useName — --name <имя> из аргументов: служба switchboard-keeper-<имя>, папка ~/.switchboard-<имя> в SWITCHBOARD_HOME: держатели и части наследуют её и
// имени не знают. Возвращает остальные аргументы.
func useName(args []string) ([]string, error) {
	rest := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] != "--name" {
			rest = append(rest, args[i])
			continue
		}
		i++
		if i == len(args) || !machine.ValidName(args[i]) {
			return nil, fmt.Errorf("--name <имя> — без путей")
		}
		u, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		fleetName = args[i]
		os.Setenv("SWITCHBOARD_HOME", filepath.Join(u, ".switchboard-"+fleetName))
	}
	return rest, nil
}

func main() {
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	args := os.Args[min(2, len(os.Args)):]
	// у держателя свои аргументы и команда процесса после --: папку он получает в окружении
	if cmd == "hold" {
		os.Exit(holder.Main(args))
	}
	args, err := useName(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper:", err)
		os.Exit(2)
	}
	if isService() {
		runService()
		return
	}
	switch cmd {
	case "run":
		os.Exit(runConsole(args))
	case "install":
		if err := install(args); err != nil {
			fmt.Fprintln(os.Stderr, "install:", err)
			os.Exit(1)
		}
	case "uninstall":
		if err := uninstall(); err != nil {
			fmt.Fprintln(os.Stderr, "uninstall:", err)
			os.Exit(1)
		}
	case "version":
		fmt.Println(version())
	default:
		fmt.Fprintln(os.Stderr, "keeper "+version()+": run [--hide] | install [--worker <имя>=<https>]… [--logon] | uninstall | hold … | version; у run, install, uninstall — [--name <имя>]")
		os.Exit(2)
	}
}

// start — keeper на своей папке: вход службы, задачи и консоли.
func start(echo io.Writer) (*keeper.Keeper, error) {
	home, err := machine.Home()
	if err != nil {
		return nil, err
	}
	k, err := keeper.New(home, echo, keeper.Options{Version: version()})
	if err != nil {
		return nil, err
	}
	k.Run()
	return k, nil
}

// runConsole — keeper в консоли; SIGINT или SIGTERM — штатная остановка; остановился сам — только после подмены себя: ОС поднимет новый файл.
func runConsole(args []string) int {
	for _, a := range args {
		if a == "--hide" {
			hideConsole()
		}
	}
	k, err := start(os.Stderr)
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
		return 3
	}
}
