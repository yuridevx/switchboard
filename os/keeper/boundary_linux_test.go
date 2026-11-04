//go:build linux

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Сигнал остановки от ОС держателю: ввод процесса закрыт, процесс вышел штатно, выход отдан хозяину.
func TestEtHolderSignalClosesInput(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf heldFile
	b, _ := os.ReadFile(heldPath(home, "s"))
	json.Unmarshal(b, &hf)
	// подключение принято — держатель уже слушает сигналы
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	syscall.Kill(hf.Holder, syscall.SIGTERM)
	var out strings.Builder
	x, err := c.read(func(b []byte) { out.Write(b) })
	if err != nil || x == nil || x.Code == nil || *x.Code != 0 || !x.OSStop || !strings.Contains(out.String(), "bye") {
		t.Fatalf("выход %+v %v, вывод %q", x, err, out.String())
	}
	if !journalHas(home, `"ev":"hold_signal"`) {
		t.Fatal("нет строки hold_signal")
	}
}

// 5508 · Вышедший держатель не остаётся зомби у того, кто его запустил (wsl 3 нояб.: 23 зомби [keeper] под keeper run
// за 11 ч — holdProc отпускал держателя без Wait).
func TestEtHolderReaped(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf heldFile
	b, _ := os.ReadFile(heldPath(home, "s"))
	json.Unmarshal(b, &hf)
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	c.closeInput()
	if x, err := c.read(func([]byte) {}); err != nil || x == nil {
		t.Fatalf("выход %+v %v", x, err)
	}
	c.Close()
	// забранный процесс исчезает из таблицы целиком; зомби отвечает на сигнал 0
	waitFor(t, "держатель забран", func() bool { return syscall.Kill(hf.Holder, 0) != nil })
}

// 5512 · Сигнал ОС держателю без хозяина: hold_signal, процесс вышел, через ownerWait — held_unclaimed, файл убран,
// держатель вышел (ubuntu-db 3 нояб.: после TERM Host вышел, а держатель жил до KILL).
func TestEtHolderSignalNoOwner(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	if _, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=300ms"), Cmd: []string{self, "app"}}); err != nil {
		t.Fatal(err)
	}
	var hf heldFile
	b, _ := os.ReadFile(heldPath(home, "s"))
	json.Unmarshal(b, &hf)
	time.Sleep(300 * time.Millisecond) // держатель слушает сигналы
	syscall.Kill(hf.Holder, syscall.SIGTERM)
	waitFor(t, "держатель вышел", func() bool { return !isThere(heldPath(home, "s")) && !alive(hf.Holder) })
	if !journalHas(home, `"ev":"hold_signal"`) || !journalHas(home, `"ev":"held_unclaimed"`) {
		t.Fatal("нет hold_signal или held_unclaimed")
	}
}

// 5517 · Процесс не вышел на закрытие ввода после сигнала — держатель сам его не убивает (таймер — у ОС); KILL
// держателю, которым ОС кончает остановку, — процесс умер (устав: «не успела — жёсткий выход, это ожидаемая ветка»;
// чьё: код — serve).
func TestEtSignalDeafProcessOSKills(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app", "deaf"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf heldFile
	b, _ := os.ReadFile(heldPath(home, "s"))
	json.Unmarshal(b, &hf)
	time.Sleep(300 * time.Millisecond)
	syscall.Kill(hf.Holder, syscall.SIGTERM)
	waitFor(t, "hold_signal", func() bool { return journalHas(home, `"ev":"hold_signal"`) })
	time.Sleep(500 * time.Millisecond)
	if !alive(hf.Holder) || !alive(f.Pid) {
		t.Fatal("держатель или процесс ушли без KILL")
	}
	syscall.Kill(hf.Holder, syscall.SIGKILL)
	waitFor(t, "процесс умер с держателем", func() bool { return !alive(f.Pid) })
}

// 5524 · uninstall --name снимает только свою службу: свой юнит удалён, чужой на месте; юнит своего имени запускает
// run --name (дизайн «Любой агент», этап 0). systemctl — подделка: пишет свои аргументы.
func TestEtNameOwnUnitOnly(t *testing.T) {
	dir, u := t.TempDir(), t.TempDir()
	log := filepath.Join(dir, "calls")
	os.WriteFile(filepath.Join(dir, "systemctl"), []byte("#!/bin/sh\necho \"$@\" >> "+log+"\n"), 0o755)
	os.WriteFile(filepath.Join(dir, "loginctl"), []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("XDG_CONFIG_HOME", u)
	units := filepath.Join(u, "systemd", "user")
	os.MkdirAll(units, 0o755)
	other := filepath.Join(units, "switchboard-keeper.service")
	own := filepath.Join(units, "switchboard-keeper-prod.service")
	os.WriteFile(other, []byte("x"), 0o644)
	os.WriteFile(own, []byte("x"), 0o644)
	home := t.TempDir()
	if code, _, e := runKeeper(t, home, "", "uninstall", "--name", "prod"); code != 0 {
		t.Fatalf("uninstall: код %d, %q", code, e)
	}
	if _, err := os.Stat(own); !os.IsNotExist(err) {
		t.Fatalf("свой юнит на месте: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("чужой юнит снят: %v", err)
	}
	if b, _ := os.ReadFile(log); !strings.Contains(string(b), "disable --now switchboard-keeper-prod.service") || strings.Contains(string(b), "switchboard-keeper.service") {
		t.Fatalf("вызовы systemctl: %s", b)
	}
}

// linuxBench — поддельные systemctl и loginctl, gate принимает приглашение; юниты — во временной папке.
func linuxBench(t *testing.T, systemctl string) (units, log, gateURL string, u string) {
	t.Helper()
	u = nameStand(t)
	dir := t.TempDir()
	log = filepath.Join(dir, "calls")
	os.WriteFile(filepath.Join(dir, "systemctl"), []byte("#!/bin/sh\necho \"$@\" >> "+log+"\n"+systemctl+"\n"), 0o755)
	os.WriteFile(filepath.Join(dir, "loginctl"), []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("XDG_CONFIG_HOME", u)
	units = filepath.Join(u, "systemd", "user")
	os.MkdirAll(units, 0o755)
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"type": "reply", "id": "install", "ok": true, "result": map[string]string{"key": "host.pc.ab12.sig"}})
	}))
	t.Cleanup(gate.Close)
	return units, log, gate.URL, u
}

// 5562 · install --name на Linux: свой юнит с файлом своей папки и run --name; enable и restart — только свой; юнит первого
// флота не тронут (дизайн «Любой агент», этап 0).
func TestEtNameInstallOwnUnit(t *testing.T) {
	units, log, gate, u := linuxBench(t, "")
	first := filepath.Join(units, "switchboard-keeper.service")
	os.WriteFile(first, []byte("первый флот"), 0o644)
	if code, _, e := runKeeper(t, t.TempDir(), "invite\n", "install", "--name", "prod", "--worker", "gate="+gate); code != 0 {
		t.Fatalf("install: код %d, %q", code, e)
	}
	b, err := os.ReadFile(filepath.Join(units, "switchboard-keeper-prod.service"))
	if err != nil {
		t.Fatal(err)
	}
	want := `ExecStart="` + filepath.Join(u, ".switchboard-prod", "keeper") + `" run --name prod`
	if !strings.Contains(string(b), want) {
		t.Fatalf("юнит без %q: %s", want, b)
	}
	calls, _ := os.ReadFile(log)
	for _, c := range []string{"enable switchboard-keeper-prod.service", "restart switchboard-keeper-prod.service"} {
		if !strings.Contains(string(calls), c) {
			t.Fatalf("нет %q: %s", c, calls)
		}
	}
	if strings.Contains(string(calls), "switchboard-keeper.service") {
		t.Fatalf("задет первый флот: %s", calls)
	}
	if got, _ := os.ReadFile(first); string(got) != "первый флот" {
		t.Fatalf("юнит первого флота переписан: %s", got)
	}
}

// 5563 · Установка поверх своего имени — без отказа: юнит переписан, перезапуск своего, держатели живут (KillMode=process)
// (чьё: код — service_linux.go «установка поверх работающей службы — перезапуск с новым юнитом и файлом; держатели живут»).
func TestEtNameInstallOverOwn(t *testing.T) {
	units, log, gate, _ := linuxBench(t, "")
	own := filepath.Join(units, "switchboard-keeper-prod.service")
	other := filepath.Join(units, "switchboard-keeper-other.service")
	os.WriteFile(own, []byte("старый"), 0o644)
	os.WriteFile(other, []byte("чужой"), 0o644)
	if code, _, e := runKeeper(t, t.TempDir(), "invite\n", "install", "--name", "prod", "--worker", "gate="+gate); code != 0 {
		t.Fatalf("install: код %d, %q", code, e)
	}
	if b, _ := os.ReadFile(own); !strings.Contains(string(b), "KillMode=process") || !strings.Contains(string(b), "Restart=always") || !strings.Contains(string(b), "StartLimitIntervalSec=0") || !strings.Contains(string(b), "RestartSec=1") {
		t.Fatalf("юнит: %s", b)
	}
	if b, _ := os.ReadFile(other); string(b) != "чужой" {
		t.Fatalf("чужой юнит: %s", b)
	}
	if calls, _ := os.ReadFile(log); !strings.Contains(string(calls), "restart switchboard-keeper-prod.service") || strings.Contains(string(calls), "other") {
		t.Fatalf("вызовы: %s", calls)
	}
}

// 5566 · uninstall имени, которого нет: код 1, причина словом; другой юнит на месте (устав «система ловит»; дизайн этапа 0).
func TestEtNameUninstallUnknownUnit(t *testing.T) {
	units, _, _, _ := linuxBench(t, "echo 'Unit file does not exist' >&2; exit 1")
	other := filepath.Join(units, "switchboard-keeper.service")
	os.WriteFile(other, []byte("x"), 0o644)
	code, _, e := runKeeper(t, t.TempDir(), "", "uninstall", "--name", "typo")
	if code != 1 || !strings.Contains(e, "uninstall:") || !strings.Contains(e, "Unit file does not exist") {
		t.Fatalf("код %d, %q", code, e)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("другой юнит: %v", err)
	}
}

// 5568 · SIGTERM keeper под именем: код 0, последняя строка keeper — keeper_exit в своей папке; своя часть и второй keeper живут
// (устав «каждая часть останавливается штатно»; чьё: код — main.go «штатная остановка keeper (держатели и их процессы живут)»).
func TestEtNameGracefulStop(t *testing.T) {
	u := nameStand(t)
	a := newNamedKeeper(t, u, "a")
	b := newNamedKeeper(t, u, "b")
	pidA, pidB := a.partPid(), b.partPid()
	a.cmd.Process.Signal(syscall.SIGTERM)
	if err := a.cmd.Wait(); err != nil {
		t.Fatalf("выход: %v", err)
	}
	var last string
	for _, l := range strings.Split(journalText(a.own), "\n") {
		if strings.Contains(l, `"who":"keeper"`) {
			last = l
		}
	}
	if !strings.Contains(last, "keeper_exit") {
		t.Fatalf("последняя строка keeper: %s", last)
	}
	if !alive(pidA) || !alive(pidB) || b.cmd.ProcessState != nil {
		t.Fatalf("задеты: часть a %v, часть b %v", alive(pidA), alive(pidB))
	}
}

// alive — процесс жив и не зомби.
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	b, err := os.ReadFile("/proc/" + itoa(pid) + "/stat")
	return err == nil && !strings.Contains(string(b), ") Z ")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

func killPid(t *testing.T, pid int) {
	t.Helper()
	syscall.Kill(pid, syscall.SIGKILL)
}

// detachProc — держатель без хозяина: своя сессия.
func detachProc(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

// Остановка ОС: держатель закрыл ввод части по сигналу — выход не падение: без перезапуска и без part.failed, в том числе когда сигнал
// пришёл и самому процессу (ВМ win11-2 1 нояб.: на перезагрузке держатель узнал об остановке на 5 с раньше службы; выключение шлёт SIGTERM
// всей cgroup).
func TestEtOSStopIsNotCrash(t *testing.T) {
	for _, both := range []bool{false, true} {
		s := newStand(t)
		s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
		k := s.start()
		waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
		var hf heldFile
		b, _ := os.ReadFile(heldPath(s.home, "capture"))
		json.Unmarshal(b, &hf)
		syscall.Kill(hf.Holder, syscall.SIGTERM)
		if both {
			syscall.Kill(hf.Pid, syscall.SIGTERM)
		}
		waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
		time.Sleep(time.Second)
		starts := strings.Count(readJournal(s.home), `"ev":"part_start"`)
		if p := partOf(k, "capture"); p.State != "stopped" || p.Restarts != 0 || starts != 1 || s.relay.ledgerHas("part.failed") || !journalHas(s.home, `"why":"остановка ОС: `) {
			t.Fatalf("выход по остановке ОС принят за падение: %+v, стартов %d", p, starts)
		}
	}
}
