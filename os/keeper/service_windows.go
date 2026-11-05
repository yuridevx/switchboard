package main

import "golang.org/x/sys/windows/svc"

type handler struct{}

func (handler) Execute(_ []string, _ <-chan svc.ChangeRequest, _ chan<- svc.Status) (bool, uint32) {
	return false, 9
}
