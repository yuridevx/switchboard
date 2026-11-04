// keeper снесён: вход контракта отказывает словом.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "keeper: снесено")
	os.Exit(1)
}
