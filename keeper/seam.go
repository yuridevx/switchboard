package main

// Что стенд берёт из кода мимо процесса: keeper в процессе теста с короткими пределами и подготовка машины без регистрации в ОС.
// Всё остальное стенд видит снаружи: кадры, POST, файлы, протокол держателя, команды файла.
import (
	"bufio"
	"encoding/json"
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

func (k *Keeper) StateJSON() []byte { b, _ := json.Marshal(k.State()); return b }

// bootKeeper — keeper на папке home: тот же старт, что у службы.
func bootKeeper(home string, t tuning) (keeperHandle, error) {
	k, err := newKeeper(home, Options{Stop: t.stop, PlanWait: t.planWait, Ping: t.ping, PauseFirst: t.pauseFirst,
		PauseMax: t.pauseMax, Download: t.download, HolderWait: t.holderWait, Self: t.self})
	if err != nil {
		return nil, err
	}
	k.Run()
	return k, nil
}

// setOwnerWait — предел ожидания хозяина в процессе держателя.
func setOwnerWait(d time.Duration) { ownerWait = d }

// setFleet — флот без аргументов командной строки.
func setFleet(name string) { fleetName = name }

// prepareMachine — всё, что установка делает до регистрации в ОС: приглашение, keeper.json, machine.key, файл keeper на месте.
func prepareMachine(args []string, in *bufio.Reader) (string, error) {
	f, err := parseInstall(args)
	if err != nil {
		return "", err
	}
	invite, err := readInvite(in)
	if err != nil {
		return "", err
	}
	if err := prepareConf(f, invite); err != nil {
		return "", err
	}
	return placeSelf()
}
