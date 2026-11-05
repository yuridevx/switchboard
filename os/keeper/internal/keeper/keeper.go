// Снесено.
package keeper

import (
	"errors"
	"time"
)

type Options struct {
	Version                                                        string
	StopLimit, PlanWait, Ping, PauseFirst, PauseMax, Download, HolderWait time.Duration
	Self                                                           func() (string, error)
}

type Keeper struct{}

func New(home string, _ any, o Options) (*Keeper, error) { return nil, errors.New("снесено") }
func (*Keeper) Run()                                     {}
func (*Keeper) Stop()                                    {}
func (*Keeper) Done() <-chan struct{}                    { return nil }
func (*Keeper) State() struct{}                          { return struct{}{} }
