//go:build linux

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Сигнал остановки от ОС держателю: ввод процесса закрыт, процесс вышел штатно, выход отдан хозяину с отметкой os_stop.
func TestEtHolderSignalClosesInput(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self(), "app"}})
	if err != nil {
		t.Fatal(err)
	}
	// сигнал — сразу после строки о себе: кто её прочитал, может его прислать
	syscall.Kill(heldOf(home, "s").Holder, syscall.SIGTERM)
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	x, err := c.read(func(b []byte) { out.Write(b) })
	if err != nil || x == nil || x.Code == nil || *x.Code != 0 || !x.OSStop || !strings.Contains(out.String(), "bye") {
		t.Fatalf("выход %+v %v, вывод %q", x, err, out.String())
	}
	if !has(home, J{"ev": "hold_signal"}) {
		t.Fatal("нет строки hold_signal")
	}
}

// 5508 · Вышедший держатель не остаётся зомби у того, кто его запустил (wsl 3 нояб.: 23 зомби [keeper] под keeper run за 11 ч — holdProc
// отпускал держателя без Wait).
func TestEtHolderReaped(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self(), "app"}})
	if err != nil {
		t.Fatal(err)
	}
	hf := heldOf(home, "s")
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

// 5517 · Процесс не вышел на закрытие ввода после сигнала — держатель сам его не убивает (таймер — у ОС); KILL держателю, которым ОС кончает
// остановку, — процесс умер (устав: «не успела — жёсткий выход, это ожидаемая ветка»).
func TestEtSignalDeafProcessOSKills(t *testing.T) {
	home := holderHome(t)
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self(), "app", "deaf"}})
	if err != nil {
		t.Fatal(err)
	}
	hf := heldOf(home, "s")
	time.Sleep(300 * time.Millisecond)
	syscall.Kill(hf.Holder, syscall.SIGTERM)
	waitFor(t, "hold_signal", func() bool { return has(home, J{"ev": "hold_signal"}) })
	time.Sleep(500 * time.Millisecond)
	if !alive(hf.Holder) || !alive(f.Pid) {
		t.Fatal("держатель или процесс ушли без KILL")
	}
	syscall.Kill(hf.Holder, syscall.SIGKILL)
	waitFor(t, "процесс умер с держателем", func() bool { return !alive(f.Pid) })
}

// linuxBench — поддельные systemctl и loginctl (systemctl пишет свои аргументы и отказывает про юнит typo), gate принимает приглашение; юниты —
// во временной папке.
func linuxBench(t *testing.T) (units, log, gateURL string, u string) {
	t.Helper()
	u = nameStand(t)
	dir := t.TempDir()
	log = filepath.Join(dir, "calls")
	os.WriteFile(filepath.Join(dir, "systemctl"), []byte("#!/bin/sh\necho \"$@\" >> "+log+"\ncase \"$*\" in *typo*) echo 'Unit file does not exist' >&2; exit 1;; esac\n"), 0o755)
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

// 5562 · 5563 · install --name на Linux: свой юнит с файлом своей папки и run --name, поверх своего — без отказа: юнит переписан, enable и
// restart — только свой, держатели живут (KillMode=process); юниты первого флота и других имён не тронуты (дизайн «Любой агент», этап 0; чьё:
// код — «установка поверх работающей службы — перезапуск с новым юнитом и файлом; держатели живут»).
func TestEtNameInstallOwnUnit(t *testing.T) {
	units, log, gate, u := linuxBench(t)
	first := filepath.Join(units, "switchboard-keeper.service")
	own := filepath.Join(units, "switchboard-keeper-prod.service")
	other := filepath.Join(units, "switchboard-keeper-other.service")
	os.WriteFile(first, []byte("первый флот"), 0o644)
	os.WriteFile(own, []byte("старый"), 0o644)
	os.WriteFile(other, []byte("чужой"), 0o644)
	if code, _, e := runKeeper(t, t.TempDir(), "invite\n", "install", "--name", "prod", "--worker", "gate="+gate); code != 0 {
		t.Fatalf("install: код %d, %q", code, e)
	}
	b, _ := os.ReadFile(own)
	for _, want := range []string{`ExecStart="` + filepath.Join(u, ".switchboard-prod", "keeper") + `" run --name prod`, "KillMode=process", "Restart=always", "StartLimitIntervalSec=0", "RestartSec=1"} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("юнит без %q: %s", want, b)
		}
	}
	calls, _ := os.ReadFile(log)
	for _, c := range []string{"enable switchboard-keeper-prod.service", "restart switchboard-keeper-prod.service"} {
		if !strings.Contains(string(calls), c) {
			t.Fatalf("нет %q: %s", c, calls)
		}
	}
	if strings.Contains(string(calls), "switchboard-keeper.service") || strings.Contains(string(calls), "other") {
		t.Fatalf("задеты чужие юниты: %s", calls)
	}
	for f, want := range map[string]string{first: "первый флот", other: "чужой"} {
		if got, _ := os.ReadFile(f); string(got) != want {
			t.Fatalf("чужой юнит переписан: %s", got)
		}
	}
}

// 5524 · 5566 · uninstall --name снимает только свою службу: свой юнит удалён, чужой на месте; uninstall имени, которого нет, — код 1, причина
// словом (дизайн «Любой агент», этап 0; устав «система ловит»).
func TestEtNameUninstallOwnUnit(t *testing.T) {
	units, log, _, _ := linuxBench(t)
	other := filepath.Join(units, "switchboard-keeper.service")
	own := filepath.Join(units, "switchboard-keeper-prod.service")
	os.WriteFile(other, []byte("x"), 0o644)
	os.WriteFile(own, []byte("x"), 0o644)
	if code, _, e := runKeeper(t, t.TempDir(), "", "uninstall", "--name", "prod"); code != 0 {
		t.Fatalf("uninstall: код %d, %q", code, e)
	}
	if _, err := os.Stat(own); !os.IsNotExist(err) {
		t.Fatalf("свой юнит на месте: %v", err)
	}
	if b, _ := os.ReadFile(log); !strings.Contains(string(b), "disable --now switchboard-keeper-prod.service") || strings.Contains(string(b), "switchboard-keeper.service") {
		t.Fatalf("вызовы systemctl: %s", b)
	}
	code, _, e := runKeeper(t, t.TempDir(), "", "uninstall", "--name", "typo")
	if code != 1 || !strings.Contains(e, "uninstall") || !strings.Contains(e, "Unit file does not exist") {
		t.Fatalf("uninstall неизвестного: код %d, %q", code, e)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("чужой юнит снят: %v", err)
	}
}

// 5568 · SIGTERM keeper под именем: код 0, последняя строка keeper — keeper_exit в своей папке; своя часть и второй keeper живут (устав «каждая
// часть останавливается штатно»; чьё: код — «штатная остановка keeper (держатели и их процессы живут)»).
func TestEtNameGracefulStop(t *testing.T) {
	u := nameStand(t)
	a := newNamedKeeper(t, u, "a")
	b := newNamedKeeper(t, u, "b")
	pidA, pidB := a.partPid(), b.partPid()
	a.cmd.Process.Signal(syscall.SIGTERM)
	if err := a.cmd.Wait(); err != nil {
		t.Fatalf("выход: %v", err)
	}
	if l := lastKeeperLine(a.own); l["ev"] != "keeper_exit" {
		t.Fatalf("последняя строка keeper: %v", l)
	}
	if !alive(pidA) || !alive(pidB) || b.cmd.ProcessState != nil {
		t.Fatalf("задеты: часть a %v, часть b %v", alive(pidA), alive(pidB))
	}
}

// Остановка ОС: держатель закрыл ввод части по сигналу — выход не падение: без перезапуска и без part.failed, в том числе когда сигнал пришёл и
// самому процессу, и в любом порядке (ВМ win11-2 1 нояб.: на перезагрузке держатель узнал об остановке на 5 с раньше службы; выключение шлёт SIGTERM
// всей cgroup, порядка нет; серия 6 нояб.: процесс вышел раньше, чем держатель отметил сигнал, — падение и перезапуск, 2 из 30 и на старом коде).
func TestEtOSStopIsNotCrash(t *testing.T) {
	for _, order := range []string{"держатель", "держатель и процесс", "процесс, затем держатель"} {
		s := newStand(t)
		s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
		k := s.start()
		waitFor(t, "running", running(k, "capture", ""))
		hf := heldOf(s.home, "capture")
		switch order {
		case "держатель":
			syscall.Kill(hf.Holder, syscall.SIGTERM)
		case "держатель и процесс":
			syscall.Kill(hf.Holder, syscall.SIGTERM)
			syscall.Kill(hf.Pid, syscall.SIGTERM)
		default:
			syscall.Kill(hf.Pid, syscall.SIGTERM)
			time.Sleep(100 * time.Millisecond) // процесс вышел первым: держатель узнаёт об остановке позже
			syscall.Kill(hf.Holder, syscall.SIGTERM)
		}
		waitFor(t, "stopped: "+order, func() bool { return partOf(k, "capture").State == "stopped" })
		time.Sleep(time.Second)
		starts := count(s.home, J{"ev": "part_start"})
		if p := partOf(k, "capture"); p.State != "stopped" || p.Restarts != 0 || starts != 1 || s.relay.ledgerHas("part.failed") || !has(s.home, J{"part": "capture", "ev": "part_exit", "why": sub("остановка ОС")}) {
			t.Fatalf("выход по остановке ОС принят за падение: %+v, стартов %d", p, starts)
		}
	}
}

// alive — процесс жив и не зомби.
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	return err == nil && !strings.Contains(string(b), ") Z ")
}

func killPid(t *testing.T, pid int) {
	t.Helper()
	syscall.Kill(pid, syscall.SIGKILL)
}

// detachProc — держатель без хозяина: своя сессия.
func detachProc(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
