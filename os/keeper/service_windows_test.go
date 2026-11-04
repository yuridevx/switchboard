//go:build windows

package main

import (
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"
)

// 7307 · служба Windows: Stop и Shutdown — штатная остановка keeper: Stopped с кодом 0, последняя строка keeper в журнале — keeper_exit
// (устав «каждая часть останавливается штатно»; чьё: код — handler.Execute). Диспетчер служб в тесте не нужен: Execute — обычный метод.
func TestEtServiceStop(t *testing.T) {
	for _, cmd := range []svc.Cmd{svc.Stop, svc.Shutdown} {
		home := t.TempDir()
		t.Setenv("SWITCHBOARD_HOME", home)
		r := make(chan svc.ChangeRequest)
		s := make(chan svc.Status, 8)
		type out struct {
			special bool
			code    uint32
		}
		done := make(chan out, 1)
		go func() {
			a, b := handler{}.Execute(nil, r, s)
			done <- out{a, b}
		}()
		deadline := time.After(30 * time.Second)
		for running := false; !running; {
			select {
			case st := <-s:
				running = st.State == svc.Running
			case <-deadline:
				t.Fatal("служба не дошла до Running")
			}
		}
		r <- svc.ChangeRequest{Cmd: cmd}
		select {
		case o := <-done:
			if o.special || o.code != 0 {
				t.Fatalf("выход службы: %v %d", o.special, o.code)
			}
		case <-deadline:
			t.Fatal("служба не остановилась")
		}
		var last string
		for _, l := range strings.Split(journalText(home), "\n") {
			if strings.Contains(l, `"who":"keeper"`) {
				last = l
			}
		}
		if !strings.Contains(last, "keeper_exit") {
			t.Fatalf("последняя строка keeper: %s", last)
		}
	}
}
