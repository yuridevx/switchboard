//go:build windows

package main

import "golang.org/x/sys/windows/svc"

type handler struct{}

// Execute — снесено: служба не стартует.
func (handler) Execute([]string, <-chan svc.ChangeRequest, chan<- svc.Status) (bool, uint32) { return true, 1 }
