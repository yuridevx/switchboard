package main

// Подмена себя — последним шагом плана: sha256 своего файла не тот, что у файла Keeper в плане → новый файл скачан, сверен, ответил на
// version номером сборки плана → свой файл подменён, keeper выходит, ОС поднимает новый; Host и сессии живут у держателей.
// Сбой — строка в журнале машины и в журнале флота; тот же план в следующий раз пробует снова.
import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// selfUpdate — файл Keeper из плана; true — файл подменён, keeper выходит.
func (k *Keeper) selfUpdate(p plan) bool {
	if p.Keeper.Sha256 == "" || p.Keeper.Sha256 == k.selfSha {
		return false
	}
	failed := func(why string) bool {
		k.fault("keeper_failed", "build", p.Build, "why", why)
		k.ledger("keeper.failed", fmt.Sprintf("Keeper %d — %s", p.Build, why), map[string]any{"build": p.Build})
		return false
	}
	b, err := k.fetch(fmt.Sprintf("Keeper %d", p.Build), p.Keeper)
	if k.ctx.Err() != nil {
		return false
	}
	if err != nil {
		return failed(err.Error())
	}
	dir := filepath.Join(k.home, "keeper-next")
	os.RemoveAll(dir)
	defer os.RemoveAll(dir)
	bin := filepath.Join(dir, exe("keeper"))
	os.MkdirAll(dir, 0o700)
	if err := os.WriteFile(bin, b, 0o755); err != nil {
		return failed("новый файл не записан: " + err.Error())
	}
	ctx, cancel := context.WithTimeout(k.ctx, k.o.Stop)
	check := exec.CommandContext(ctx, bin, "version")
	check.WaitDelay = waitDelay
	detached(check) // своя группа, без окна: у keeper под задачей при входе консоли нет
	out, err := check.Output()
	late := ctx.Err() == context.DeadlineExceeded
	cancel()
	if k.ctx.Err() != nil {
		return false // остановка прервала проверку: это не сбой подмены
	}
	if late {
		return failed(fmt.Sprintf("check_failed: новый файл не ответил за %v", k.o.Stop))
	}
	if got := strings.TrimSpace(string(out)); err != nil || got != strconv.Itoa(p.Build) {
		return failed(fmt.Sprintf("check_failed: новый файл ответил «%s» (%v), а в плане сборка %d", got, err, p.Build))
	}
	target, err := k.o.Self()
	if err == nil {
		err = replace(target, bin)
	}
	if err != nil {
		return failed("подмена: " + err.Error())
	}
	k.note("self_update", "from", buildNumber(), "to", p.Build, "why", "файл подменён — выход, ОС поднимет новый")
	k.ledger("keeper.updated", fmt.Sprintf("Keeper %d → %d", buildNumber(), p.Build), map[string]any{"from": buildNumber(), "to": p.Build})
	return true
}

// replace — dst становится копией src: копия рядом, прежний файл — в <dst>.<сборка>.<pid>.old (занятое и работающее имя не мешает),
// копия на место. Не вышло — dst прежний. Прежние файлы убирает старт keeper.
func replace(dst, src string) error {
	next := dst + ".new"
	if err := copyFile(next, src); err != nil {
		return err
	}
	old := fmt.Sprintf("%s.%s.%d.old", dst, build, os.Getpid())
	if err := os.Rename(dst, old); err != nil && !os.IsNotExist(err) {
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
