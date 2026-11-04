package keeper

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"switchboard/keeper/internal/release"
)

// selfUpdate — новый файл ответил своей версией → подменить свой файл и остановиться; ОС поднимет новый. Держатели и их процессы живут дальше: новый keeper
// подключится к ним. Сбой — keeper failed, как у любой части.
func (k *Keeper) selfUpdate(e Entry) {
	fail := func(why string) { k.fail(k.slot("keeper"), e.Version, why) }
	dir, err := k.in.Install(k.bg, e.source())
	if k.stopping() {
		return
	}
	if err != nil {
		fail(err.Error())
		return
	}
	bin := release.KeeperBinary(dir)
	ctx, cancel := context.WithTimeout(context.Background(), k.o.StopLimit)
	defer cancel()
	check := exec.CommandContext(ctx, bin, "version")
	check.WaitDelay = 5 * time.Second
	out, err := check.Output()
	if ctx.Err() != nil {
		fail(fmt.Sprintf("check_failed: новый файл не ответил за %v", k.o.StopLimit))
		return
	}
	if got := strings.TrimSpace(string(out)); err != nil || got != e.Version {
		fail(fmt.Sprintf("check_failed: новый файл ответил «%s» (%v), а в плане %s", got, err, e.Version))
		return
	}
	self, err := k.o.Self()
	if err != nil {
		fail(err.Error())
		return
	}
	// прежний файл держат держатели, пока живы, — иногда днями: имя у него каждый раз новое
	old := fmt.Sprintf("%s.%s.%d.old", self, k.o.Version, os.Getpid())
	if err := release.Replace(bin, self, old); err != nil {
		fail("подмена: " + err.Error())
		return
	}
	// свои папки версий — новая и та, с которой уходим: прежний файл для отката лежит рядом
	k.cleanVersions("keeper", e.Version, k.o.Version)
	k.j.Note("self_update", "from", k.o.Version, "to", e.Version, "why", "файл подменён — выход, ОС поднимет новый")
	k.ledger("part.updated", fmt.Sprintf("keeper %s → %s", k.o.Version, e.Version))
	// остановку ждёт цикл, в котором мы сейчас: своей горутиной; выход процесса — по Done у того, кто запустил
	go k.Stop()
}
