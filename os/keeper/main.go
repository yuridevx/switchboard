// keeper — служба ОС Switchboard: исполнитель плана машины.
//
//	keeper run [--hide]   — в консоли; Ctrl+C — штатная остановка keeper (держатели и их процессы живут)
//	keeper install        — приглашение машины — первой строкой stdin: keeper принимает его у gate и кладёт пропуск в machine.key; --worker <имя>=<https> — адреса
//	                        в keeper.json; Windows: служба под пользователем (пароль — второй строкой stdin) или --logon — задача «при входе пользователя»;
//	                        Linux — systemd --user с linger
//	keeper uninstall      — убрать службу или задачу
//	keeper hold …         — режим держателя (запускают keeper и Host)
//	keeper version        — версия
//	--name <имя>          — у run, install, uninstall: второй флот на этом компьютере, своя служба и своя папка
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
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

// fleetName — имя второго флота на компьютере.
var fleetName string

// useName — --name <имя> из аргументов: служба switchboard-keeper-<имя>, папка ~/.switchboard-<имя> в SWITCHBOARD_HOME: держатели и части наследуют её и имени не знают.
func useName(args []string) ([]string, error) {
	rest := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] != "--name" {
			rest = append(rest, args[i])
			continue
		}
		i++
		if i == len(args) || !machine.ValidName(args[i]) {
			return nil, errors.New("--name <имя> — без путей")
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
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case <-stop:
		k.Stop()
		return 0
	case <-k.Done():
		return 3
	}
}

func main() {
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	args := os.Args[min(2, len(os.Args)):]
	switch cmd {
	case "hold": // у держателя свои аргументы и команда процесса после --: папку он получает в окружении
		os.Exit(holder.Main(args))
	case "version":
		fmt.Println(version())
		return
	case "run", "install", "uninstall":
	default:
		fmt.Fprintln(os.Stderr, "keeper "+version()+": run [--hide] | install [--worker <имя>=<https>]… [--logon] | uninstall | hold … | version; у run, install, uninstall — [--name <имя>]")
		os.Exit(2)
	}
	args, err := useName(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper:", err)
		os.Exit(1)
	}
	switch cmd {
	case "run":
		if isService() {
			runService()
			return
		}
		os.Exit(runConsole(args))
	case "install":
		err = install(args)
	case "uninstall":
		err = unregister()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, cmd+":", err)
		os.Exit(1)
	}
}
