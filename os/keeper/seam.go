package main

// Что стенд берёт из кода мимо процесса: keeper в процессе теста с короткими пределами, выбор флота и подготовка машины без регистрации в ОС.
// Всё остальное стенд видит снаружи: кадры, POST, файлы, протокол держателя, команды файла. Этот файл — вход лесов; других имён они не знают.
import (
	"bufio"
	"encoding/json"
	"net/http"
	"time"
)

// tuning — пределы стенда; ноль — как в работе.
type tuning struct {
	stop, planWait, ping, pauseFirst, pauseMax, download, holderWait time.Duration
	self                                                             func() (string, error)
}

// keeperHandle — запущенный keeper.
type keeperHandle interface {
	Stop()
	Done() <-chan struct{}
	StateJSON() []byte
}

type oldHandle struct{ *Keeper }

func (h oldHandle) StateJSON() []byte { b, _ := json.Marshal(h.state()); return b }

// bootKeeper — keeper на папке home: тот же старт, что у службы.
func bootKeeper(home string, t tuning) (keeperHandle, error) {
	radioPing, radioPause0, radioPauseMax = or(t.ping, 30*time.Second), or(t.pauseFirst, time.Second), or(t.pauseMax, time.Minute)
	httpClient = &http.Client{Timeout: or(t.download, 10*time.Minute)}
	holderWait = or(t.holderWait, 5*time.Second)
	k, err := newKeeper(home, nil)
	if err != nil {
		return nil, err
	}
	k.limit, k.planWait = or(t.stop, k.limit), or(t.planWait, k.planWait)
	if t.self != nil {
		k.self = t.self
	}
	k.run()
	return oldHandle{k}, nil
}

func or(a, b time.Duration) time.Duration {
	if a != 0 {
		return a
	}
	return b
}

// setOwnerWait — предел ожидания хозяина в процессе держателя.
func setOwnerWait(d time.Duration) { ownerWait = d }

func chooseFleet(args []string) ([]string, error) { return useName(args) }
func fleetCommand() []string                      { return runArgs() }
func fleetService() string                        { return serviceName }
func fleetHome() (string, error)                  { return homeDir() }

// clearFleet — флот без имени.
func clearFleet() { serviceName, fleetName = "switchboard-keeper", "" }

// prepareMachine — всё, что установка делает до регистрации в ОС: keeper.json, machine.key, файл keeper на месте.
func prepareMachine(args []string, in *bufio.Reader) (string, error) {
	f, err := parseInstall(args)
	if err != nil {
		return "", err
	}
	if err := prepareConf(f, in); err != nil {
		return "", err
	}
	return placeSelf()
}
