package main

// Подмена себя — последним шагом плана: новый файл из архива <ОС>-<архитектура>/keeper ответил своей версией → свой файл подменён, keeper
// выходит, ОС поднимает новый; держатели живут. Сбой — keeper failed, как у любой части; та же запись в следующем плане пробует снова.
import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// selfUpdate — запись keeper; true — файл подменён, keeper выходит.
func (k *Keeper) selfUpdate(e *entry) bool {
	if e == nil || e.Version == version() {
		k.locked(func() { k.self = nil })
		return false
	}
	failed := func(why string) bool {
		k.locked(func() { k.self = &part{name: "keeper", version: e.Version, state: "failed"} })
		k.fail(k.self, e.Version, why)
		return false
	}
	dir, _, err := k.install(*e, false)
	if k.ctx.Err() != nil {
		return false
	}
	if err != nil {
		return failed(err.Error())
	}
	bin := filepath.Join(dir, runtime.GOOS+"-"+runtime.GOARCH, exe("keeper"))
	ctx, cancel := context.WithTimeout(k.ctx, k.o.Check)
	out, err := exec.CommandContext(ctx, bin, "version").Output()
	late := ctx.Err() == context.DeadlineExceeded
	cancel()
	if late {
		return failed(fmt.Sprintf("check_failed: новый файл не ответил за %v", k.o.Check))
	}
	if got := strings.TrimSpace(string(out)); got != e.Version {
		return failed(fmt.Sprintf("check_failed: новый файл ответил «%s» (%v), а в плане %s", got, err, e.Version))
	}
	target, err := k.o.Self()
	if err == nil {
		err = replace(target, bin)
	}
	if err != nil {
		return failed("подмена: " + err.Error())
	}
	k.prune("keeper", version(), e.Version)
	k.note("self_update", "from", version(), "to", e.Version, "why", "файл подменён — выход, ОС поднимет новый")
	k.ledger("part.updated", fmt.Sprintf("keeper %s → %s", version(), e.Version))
	return true
}

// replace — dst становится копией src: копия рядом, прежний файл — в <dst>.<версия>.<pid>.old (занятое имя не мешает), копия на место.
// Не вышло — dst прежний.
func replace(dst, src string) error {
	next := dst + ".new"
	if err := copyFile(next, src); err != nil {
		return err
	}
	old := fmt.Sprintf("%s.%s.%d.old", dst, version(), os.Getpid())
	if err := os.Rename(dst, old); err != nil {
		os.Remove(next)
		return err
	}
	if err := os.Rename(next, dst); err != nil {
		os.Rename(old, dst)
		return err
	}
	return nil
}

func copyFile(dst, src string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}
