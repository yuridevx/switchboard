package main

// Что стенд берёт из кода мимо процесса: keeper в процессе теста с короткими пределами, выбор флота и подготовка машины без регистрации в ОС.
// Всё остальное стенд видит снаружи: кадры, POST, файлы, протокол держателя, команды файла. Этот файл — вход лесов; других имён они не знают.
import (
	"bufio"
	"errors"
	"time"
)

var errGone = errors.New("снесено")

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

// bootKeeper — keeper на папке home: тот же старт, что у службы.
func bootKeeper(home string, t tuning) (keeperHandle, error) { return nil, errGone }

// setOwnerWait — предел ожидания хозяина в процессе держателя.
func setOwnerWait(d time.Duration) {}

func chooseFleet(args []string) ([]string, error) { return nil, errGone }
func fleetCommand() []string                      { return nil }
func fleetService() string                        { return "" }
func fleetHome() (string, error)                  { return "", errGone }

// clearFleet — флот без имени.
func clearFleet() {}

// prepareMachine — всё, что установка делает до регистрации в ОС: keeper.json, machine.key, файл keeper на месте.
func prepareMachine(args []string, in *bufio.Reader) (string, error) { return "", errGone }
