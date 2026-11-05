package main

import "golang.org/x/sys/windows/svc"

// handler — служба Windows: снесена, сразу выходит с кодом 1.
type handler struct{}

func (handler) Execute(_ []string, _ <-chan svc.ChangeRequest, _ chan<- svc.Status) (bool, uint32) { return false, 1 }
