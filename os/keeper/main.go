package main

import (
	"fmt"
	"os"
)

// main — keeper снесён: каждая команда отказывает словом.
func main() {
	fmt.Fprintln(os.Stderr, "keeper: снесено")
	os.Exit(1)
}
