package main

// Вход лесов: на время сноса всё отказывает словом.
import (
	"bufio"
	"errors"
	"time"
)

type tuning struct {
	stop, planWait, ping, pauseFirst, pauseMax, download, holderWait time.Duration
	self                                                             func() (string, error)
}

type keeperHandle interface {
	Stop()
	Done() <-chan struct{}
	StateJSON() []byte
}

var errGone = errors.New("снесено")

func bootKeeper(string, tuning) (keeperHandle, error)        { return nil, errGone }
func setOwnerWait(time.Duration)                             {}
func chooseFleet([]string) ([]string, error)                 { return nil, errGone }
func fleetCommand() []string                                 { return nil }
func fleetService() string                                   { return "" }
func fleetHome() (string, error)                             { return "", errGone }
func clearFleet()                                            {}
func prepareMachine([]string, *bufio.Reader) (string, error) { return "", errGone }
