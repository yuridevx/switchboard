// Снесено: команды отказывают словом.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
)

var errGone = errors.New("снесено")

var fleetName string

type installFlags struct{}

func version() string                                { return "снесено" }
func useName(args []string) ([]string, error)        { return nil, errGone }
func runArgs() []string                              { return nil }
func serviceName() string                            { return "" }
func parseInstall(args []string) (installFlags, error) { return installFlags{}, errGone }
func prepareConf(f installFlags, in *bufio.Reader) error { return errGone }
func placeSelf() (string, error)                     { return "", errGone }

func main() {
	fmt.Fprintln(os.Stderr, "keeper: снесено")
	os.Exit(9)
}
