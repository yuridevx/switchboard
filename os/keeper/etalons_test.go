package main

// Эталоны keeper из дизайна: номер эталона — номер теста.

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 20 · Host отключился посреди команды site: процесс жив, ввод не закрыт; вывод копится
// и целиком, по порядку отдаётся следующему attach раньше живого потока.
func TestEt20_HostDetachedMidCommand_OutputHeldAndReplayed(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	site, pid := e.spawn(e.host, "site")
	site.raw("ticks 120 10ms")
	for i := 1; i <= 5; i++ {
		if s := site.readLine(); s != "tick "+strconv.Itoa(i) {
			t.Fatalf("ждали tick %d, пришло %q", i, s)
		}
	}
	site.c.Close() // Host отключился посреди команды

	var buffered int
	eventually(t, "вывод копится без Host", func() bool {
		l := ctl.list()
		if len(l) != 1 || l[0]["attached"] != false {
			return false
		}
		buffered = num(l[0], "buffered")
		return buffered > 0
	})

	a, res := e.attach(e.host, "site")
	if num(res, "pid") != pid || num(res, "buffered") < buffered {
		t.Fatalf("attach: %v, ждали pid %d и buffered ≥ %d", res, pid, buffered)
	}
	// накопленное и живой поток — по порядку, без пропусков, до конца команды
	got := a.until("ticks done")
	if len(got) == 0 {
		t.Fatal("после attach нет вывода")
	}
	prev := -1
	for _, s := range got {
		n, err := strconv.Atoi(strings.TrimPrefix(s, "tick "))
		if err != nil {
			t.Fatalf("лишняя строка %q", s)
		}
		if prev >= 0 && n != prev+1 {
			t.Fatalf("порядок нарушен: %d после %d", n, prev)
		}
		prev = n
	}
	if prev != 120 {
		t.Fatalf("последний tick %d, ждали 120", prev)
	}
	// ввод не закрыт: процесс отвечает
	a.raw("echo alive")
	if s := a.readLine(); s != "alive" {
		t.Fatalf("ждали alive, пришло %q", s)
	}
	if !alive(pid) {
		t.Fatal("процесс site умер")
	}
}

// 50 · Host полузакрывает канал site; второй Host делает attach и убит без закрытия соединения.
// Процесс жив оба раза, конца ввода не получил; list — attached: false, buffered растёт; два отключения.
func TestEt50_HalfCloseAndKilledHost_ProcessUntouched(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	ctl.call(map[string]any{"op": "ready", "version": "1.4.0"})
	site, pid := e.spawn(e.host, "site")
	site.raw("ticks 400 10ms")
	site.readLine()
	site.c.(*net.TCPConn).CloseWrite() // полузакрытие от Host

	eventually(t, "attached: false после полузакрытия", func() bool {
		l := ctl.list()
		return len(l) == 1 && l[0]["attached"] == false
	})
	// второй Host: attach и убит без закрытия соединения
	e.host.exit(1, "")
	h2 := e.h.next(t)
	ctl2 := e.control(h2)
	ctl2.call(map[string]any{"op": "ready", "version": "1.4.0"})
	a2, _ := e.attach(h2, "site")
	a2.readLine()
	killPid(t, h2.Pid)

	h3 := e.h.next(t)
	ctl3 := e.control(h3)
	var b1 int
	eventually(t, "attached: false после убитого Host", func() bool {
		l := ctl3.list()
		if len(l) != 1 || l[0]["attached"] != false {
			return false
		}
		b1 = num(l[0], "buffered")
		return b1 > 0
	})
	eventually(t, "buffered растёт", func() bool { return num(ctl3.list()[0], "buffered") > b1 })
	if !alive(pid) {
		t.Fatal("процесс site умер")
	}
	// конца ввода не было: процесс по-прежнему читает ввод
	a3, _ := e.attach(h3, "site")
	a3.raw("echo still")
	for _, s := range a3.until("still") {
		if s == "bye" {
			t.Fatal("процесс получил конец ввода")
		}
	}
	js := e.journal()
	if n := len(records(js, map[string]any{"ev": "detach", "id": "site"})); n != 2 {
		t.Fatalf("отключений в журнале %d, ждали 2", n)
	}
	if n := len(records(js, map[string]any{"ev": "stderr", "id": "site", "line": "claude: stdin closed"})); n != 0 {
		t.Fatal("в stderr site — конец ввода")
	}
}

// 51 · kill без force у простаивающей wiki: ввод закрыт, claude вышел сам с 0; Host получил весь вывод,
// канал закрыт, затем exited code 0, signal null; в list wiki нет.
func TestEt51_KillClosesInput_ExitedCode0(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	wiki, _ := e.spawn(e.host, "wiki")
	r := ctl.call(map[string]any{"op": "kill", "id": "wiki"})
	if r["ok"] != true {
		t.Fatalf("kill: %v", r)
	}
	if rest := wiki.eof(); rest != "bye\n" && rest != "bye\r\n" {
		t.Fatalf("остаток вывода %q, ждали bye", rest)
	}
	ev := ctl.event("exited")
	if ev["id"] != "wiki" || ev["code"] != float64(0) || ev["signal"] != nil || ev["stderr"] != "claude: stdin closed" {
		t.Fatalf("exited: %v", ev)
	}
	if l := ctl.list(); len(l) != 0 {
		t.Fatalf("list: %v", l)
	}
}

// 52 · wiki в sleep 600, kill с force: claude и sleep завершены сразу; exited с signal.
func TestEt52_KillForce_TreeGone(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	wiki, pid := e.spawn(e.host, "wiki")
	wiki.raw("child")
	grand := childPid(t, wiki.readLine())
	wiki.raw("sleep 600s")
	start := time.Now()
	if r := ctl.call(map[string]any{"op": "kill", "id": "wiki", "force": true}); r["ok"] != true {
		t.Fatalf("kill: %v", r)
	}
	ev := ctl.event("exited")
	if ev["id"] != "wiki" || ev["signal"] != "SIGKILL" || ev["code"] != nil {
		t.Fatalf("exited: %v", ev)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("exited через %v", d)
	}
	eventually(t, "от дерева wiki ничего не осталось", func() bool { return !alive(pid) && !alive(grand) })
}

// 53 · site убит снаружи при подключённом Host: остаток вывода, канал закрыт, exited с кодом, сигналом
// и последней строкой stderr; весь stderr — в журнале; keeper процесс не перезапускает.
func TestEt53_KilledOutside_ExitedWithStderr(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	site, pid := e.spawn(e.host, "site")
	site.raw("stderr warn one")
	site.raw("echo x")
	if s := site.readLine(); s != "x" {
		t.Fatalf("ждали x, пришло %q", s)
	}
	eventually(t, "stderr в журнале", func() bool {
		return len(records(e.journal(), map[string]any{"ev": "stderr", "id": "site", "line": "warn one"})) == 1
	})
	killPid(t, pid)
	site.eof()
	ev := ctl.event("exited")
	if ev["id"] != "site" || ev["stderr"] != "warn one" || (ev["code"] == nil && ev["signal"] == nil) {
		t.Fatalf("exited: %v", ev)
	}
	if l := ctl.list(); len(l) != 0 {
		t.Fatalf("процесс перезапущен: %v", l)
	}
	js := e.journal()
	if len(records(js, map[string]any{"ev": "stderr", "id": "site", "line": "claude: start"})) != 1 {
		t.Fatal("в журнале нет всего stderr")
	}
	st := records(js, map[string]any{"ev": "exited", "id": "site", "kind": "stop"})
	if len(st) != 1 || !strings.Contains(fmt.Sprint(st[0]["why"]), "не по просьбе") {
		t.Fatalf("запись stop о выходе: %v", st)
	}
}

// 54 · Host нет на связи, wiki вышла с кодом 1; Host открыл управление — сразу после ответа exited wiki;
// в list wiki нет; накопленный вывод никому не отдан.
func TestEt54_ExitedWhileNoHost_DeliveredOnControl(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	wiki, _ := e.spawn(e.host, "wiki")
	wiki.raw("sleep 300ms")
	wiki.raw("exit 1")
	ctl.c.Close()
	wiki.c.Close()
	eventually(t, "wiki вышла", func() bool {
		return len(records(e.journal(), map[string]any{"ev": "exited", "id": "wiki"})) == 1
	})
	cl := e.host.first(t, "control", nil)
	if r := cl.read(); r["op"] != "reply" || r["ok"] != true {
		t.Fatalf("control: %v", r)
	}
	ev := cl.read()
	if ev["op"] != "exited" || ev["id"] != "wiki" || ev["code"] != float64(1) || ev["stderr"] != "fatal: exit 1" {
		t.Fatalf("сразу после ответа ждали exited wiki, пришло %v", ev)
	}
	if l := cl.list(); len(l) != 0 {
		t.Fatalf("list: %v", l)
	}
	a := e.host.first(t, "attach", map[string]any{"id": "wiki"})
	if r := a.read(); r["error"] != "unknown_id" {
		t.Fatalf("attach вышедшей: %v", r)
	}
}

// 55 · к site подключён Host; attach site, spawn site и второе управление — in_use и закрыты;
// первое соединение и процесс не тронуты; второго процесса нет.
func TestEt55_InUse(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	site, pid := e.spawn(e.host, "site")
	for _, cl := range []*client{
		e.host.first(t, "attach", map[string]any{"id": "site"}),
		e.host.first(t, "spawn", map[string]any{"id": "site", "command": e.exe, "args": []string{"claude"}}),
		e.host.first(t, "control", nil),
	} {
		if r := cl.read(); r["ok"] != false || r["error"] != "in_use" {
			t.Fatalf("ждали in_use, пришло %v", r)
		}
		cl.eof()
	}
	site.raw("echo same")
	if s := site.readLine(); s != "same" {
		t.Fatalf("первое соединение: %q", s)
	}
	l := ctl.list()
	if len(l) != 1 || num(l[0], "pid") != pid {
		t.Fatalf("list: %v", l)
	}
}

// 56 · Host после ready упал с кодом 1: код и stderr в журнале; новый Host той же версии сразу,
// во вводе — та же строка; attach к обоим; ни один процесс не перезапущен.
func TestEt56_HostCrashAfterReady_RestartedSameLine(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	ctl.call(map[string]any{"op": "ready", "version": "1.4.0"})
	_, sitePid := e.spawn(e.host, "site")
	_, profPid := e.spawn(e.host, "profiles")
	e.host.exit(1, "TypeError: boom")
	h2 := e.h.next(t)
	if h2.Version != "1.4.0" || h2.Stdin != e.host.Stdin {
		t.Fatalf("новый Host %s, ввод %q — ждали 1.4.0 и %q", h2.Version, h2.Stdin, e.host.Stdin)
	}
	st := records(e.journal(), map[string]any{"ev": "host_exit", "kind": "stop", "code": 1})
	if len(st) != 1 || !strings.Contains(fmt.Sprint(st[0]["why"]), "TypeError: boom") {
		t.Fatalf("журнал выхода Host: %v", st)
	}
	e.control(h2)
	for id, pid := range map[string]int{"site": sitePid, "profiles": profPid} {
		a, res := e.attach(h2, id)
		if num(res, "pid") != pid {
			t.Fatalf("%s: pid %d, был %d", id, num(res, "pid"), pid)
		}
		a.raw("echo " + id)
		if s := a.readLine(); s != id {
			t.Fatalf("%s ответил %q", id, s)
		}
	}
}

// 57 · после upgrade Host 1.4.1 дважды подряд выходит с кодом 1 до ready: ровно два запуска,
// причина в журнале; процессы живы; keeper.json — 1.4.0.
func TestEt57_TwoExitsBeforeReady_Stop(t *testing.T) {
	e := newEnv(t, "1.4.1")
	ctl := e.control(e.host)
	ctl.call(map[string]any{"op": "ready", "version": "1.4.0"})
	_, pid := e.spawn(e.host, "site")
	if r := ctl.call(map[string]any{"op": "upgrade", "version": "1.4.1"}); r["ok"] != true {
		t.Fatalf("upgrade: %v", r)
	}
	ctl.event("stop")
	e.host.exit(0, "")
	for i := 0; i < 2; i++ {
		h := e.h.next(t)
		if h.Version != "1.4.1" {
			t.Fatalf("запущен %s", h.Version)
		}
		h.exit(1, "gate: два владельца")
	}
	e.h.none(t, 1500*time.Millisecond)
	js := e.journal()
	if n := len(records(js, map[string]any{"ev": "host_start", "host": "1.4.1"})); n != 2 {
		t.Fatalf("запусков 1.4.1: %d", n)
	}
	f := records(js, map[string]any{"ev": "host_failed", "kind": "stop"})
	if len(f) != 1 || !strings.HasPrefix(fmt.Sprint(f[0]["why"]), "host 1.4.1: два выхода до ready — не запускаю") {
		t.Fatalf("журнал: %v", f)
	}
	if !alive(pid) {
		t.Fatal("процесс site умер")
	}
	if m, _ := readConf(e.home); m["host"] != "1.4.0" {
		t.Fatalf("keeper.json: %v", m)
	}
}

// 58 · upgrade к 1.4.1 — папка есть: ok, stop upgrade, новый Host с той же строкой, attach, ready 1.4.1,
// keeper.json → 1.4.1, процессы те же. upgrade к 9.9.9 — unknown_version, stop не отправлен.
func TestEt58_Upgrade(t *testing.T) {
	e := newEnv(t, "1.4.1")
	ctl := e.control(e.host)
	ctl.call(map[string]any{"op": "ready", "version": "1.4.0"})
	_, pid := e.spawn(e.host, "site")
	if r := ctl.call(map[string]any{"op": "upgrade", "version": "1.4.1"}); r["ok"] != true {
		t.Fatalf("upgrade: %v", r)
	}
	if s := ctl.read(); s["op"] != "stop" || s["reason"] != "upgrade" {
		t.Fatalf("ждали stop upgrade: %v", s)
	}
	e.host.exit(0, "")
	h2 := e.h.next(t)
	if h2.Version != "1.4.1" || h2.Stdin != e.host.Stdin {
		t.Fatalf("новый Host %s, ввод %q", h2.Version, h2.Stdin)
	}
	ctl2 := e.control(h2)
	if _, res := e.attach(h2, "site"); num(res, "pid") != pid {
		t.Fatalf("site перезапущен: %v", res)
	}
	if r := ctl2.call(map[string]any{"op": "ready", "version": "1.4.1"}); r["ok"] != true {
		t.Fatalf("ready: %v", r)
	}
	if m, _ := readConf(e.home); m["host"] != "1.4.1" {
		t.Fatalf("keeper.json: %v", m)
	}
	if r := ctl2.call(map[string]any{"op": "upgrade", "version": "9.9.9"}); r["error"] != "unknown_version" {
		t.Fatalf("upgrade 9.9.9: %v", r)
	}
	// stop не отправлен: следующая строка — ответ на list
	ctl2.send(map[string]any{"op": "list"})
	if r := ctl2.read(); r["op"] != "reply" {
		t.Fatalf("после unknown_version пришло %v", r)
	}
}

// 59 · первая строка с верным ключом и proto 2: contract_mismatch, закрыто; в журнале обе версии.
func TestEt59_ProtoMismatch(t *testing.T) {
	e := newEnv(t)
	cl := e.host.dial(t)
	cl.send(map[string]any{"key": e.host.key, "proto": 2, "op": "spawn", "id": "site", "command": e.exe, "args": []string{"claude"}})
	if r := cl.read(); r["ok"] != false || r["error"] != "contract_mismatch" {
		t.Fatalf("ответ: %v", r)
	}
	cl.eof()
	r := records(e.journal(), map[string]any{"kind": "refuse", "word": "contract_mismatch", "proto": 2, "keeper_proto": 1})
	if len(r) != 1 {
		t.Fatalf("журнал: %v", e.journal())
	}
	if l := e.control(e.host).list(); len(l) != 0 {
		t.Fatalf("процесс запущен: %v", l)
	}
}

// 247 · ready с новой версией после перезагрузки модулей: keeper.json → 1.4.1 без stop и перезапуска;
// ready 9.9.9 — unknown_version; после убийства Host keeper запускает 1.4.1.
func TestEt247_ReadyNewVersion_NoRestart(t *testing.T) {
	e := newEnv(t, "1.4.1")
	ctl := e.control(e.host)
	ctl.call(map[string]any{"op": "ready", "version": "1.4.0"})
	_, sitePid := e.spawn(e.host, "site")
	_, profPid := e.spawn(e.host, "profiles")
	if r := ctl.call(map[string]any{"op": "ready", "version": "1.4.1"}); r["ok"] != true {
		t.Fatalf("ready 1.4.1: %v", r)
	}
	if m, _ := readConf(e.home); m["host"] != "1.4.1" {
		t.Fatalf("keeper.json: %v", m)
	}
	if r := ctl.call(map[string]any{"op": "ready", "version": "9.9.9"}); r["error"] != "unknown_version" {
		t.Fatalf("ready 9.9.9: %v", r)
	}
	ctl.send(map[string]any{"op": "list"})
	if r := ctl.read(); r["op"] != "reply" {
		t.Fatalf("stop отправлен: %v", r)
	}
	e.h.none(t, 300*time.Millisecond)
	if m, _ := readConf(e.home); m["host"] != "1.4.1" {
		t.Fatalf("keeper.json после 9.9.9: %v", m)
	}
	killPid(t, e.host.Pid)
	h2 := e.h.next(t)
	if h2.Version != "1.4.1" {
		t.Fatalf("после убийства запущен %s", h2.Version)
	}
	l := e.control(h2).list()
	if len(l) != 2 || num(l[0], "pid") != profPid || num(l[1], "pid") != sitePid {
		t.Fatalf("процессы тронуты: %v", l)
	}
}

// 38 (экосистема) · служба ОС останавливает keeper; site занята, profiles простаивает.
// Host получил stop machine, закрыл сессии и вышел; keeper завершил оставшиеся процессы и вышел;
// процессов claude не осталось. После старта процессов нет — Host поднимет сессии по resume.
func TestEt38_ServiceStop_Graceful(t *testing.T) {
	e := newEnv(t)
	ctl := e.control(e.host)
	site, sitePid := e.spawn(e.host, "site")
	site.raw("child")
	grand := childPid(t, site.readLine())
	site.raw("sleep 60s")
	prof, profPid := e.spawn(e.host, "profiles")

	stopped := make(chan struct{})
	go func() {
		e.k.Stop()
		close(stopped)
	}()
	if s := ctl.event("stop"); s["reason"] != "machine" {
		t.Fatalf("stop: %v", s)
	}
	// Host закрывает простаивающую сессию штатно, занятая не успела — Host выходит
	if r := ctl.call(map[string]any{"op": "kill", "id": "profiles"}); r["ok"] != true {
		t.Fatalf("kill: %v", r)
	}
	prof.eof()
	if ev := ctl.event("exited"); ev["id"] != "profiles" || ev["code"] != float64(0) {
		t.Fatalf("exited: %v", ev)
	}
	e.host.exit(0, "")
	select {
	case <-stopped:
	case <-time.After(15 * time.Second):
		t.Fatal("keeper не вышел")
	}
	// SIGKILL группе асинхронен: процесс умирает чуть позже выхода keeper (CI Ubuntu 31 окт.)
	eventually(t, "после остановки не осталось процессов", func() bool {
		for _, p := range []int{sitePid, grand, profPid, e.host.Pid} {
			if alive(p) {
				return false
			}
		}
		return true
	})
	js := e.journal()
	left := records(js, map[string]any{"ev": "kill_left"})
	if len(left) != 1 || fmt.Sprint(left[0]["ids"]) != "[site]" {
		t.Fatalf("завершены keeper: %v", left)
	}
	if len(records(js, map[string]any{"ev": "keeper_exit"})) != 1 {
		t.Fatal("нет keeper_exit")
	}
	// служба ОС подняла keeper снова: новый ключ, процессов нет
	e2 := &env{t: t, home: e.home, exe: e.exe, h: e.h}
	e2.start()
	h2 := e.h.next(t)
	if h2.key == e.host.key {
		t.Fatal("ключ не сменился")
	}
	if l := e2.control(h2).list(); len(l) != 0 {
		t.Fatalf("после старта: %v", l)
	}
}

// 39 (экосистема) · локальный процесс шлёт spawn без ключа, затем с чужим: оба закрыты сразу,
// процесс не запущен, в журнале два отказа bad_key.
func TestEt39_NoKeyRefused(t *testing.T) {
	e := newEnv(t)
	for _, first := range []map[string]any{
		{"op": "spawn", "id": "x", "command": e.exe, "args": []string{"claude"}},
		{"key": strings.Repeat("0", 64), "proto": 1, "op": "spawn", "id": "x", "command": e.exe, "args": []string{"claude"}},
	} {
		cl := dialTo(t, e.k.Addr())
		cl.send(first)
		if r := cl.read(); r["ok"] != false || r["error"] != "bad_key" {
			t.Fatalf("ответ: %v", r)
		}
		cl.eof()
	}
	if n := len(records(e.journal(), map[string]any{"kind": "refuse", "word": "bad_key"})); n != 2 {
		t.Fatalf("отказов bad_key в журнале: %d", n)
	}
	if l := e.control(e.host).list(); len(l) != 0 {
		t.Fatalf("процесс запущен: %v", l)
	}
}

// 21 · процесс keeper убит; site выполняет команду с потомком, profiles простаивает.
// Host, оба процесса claude и их потомки завершились вместе с keeper. Служба ОС подняла keeper,
// keeper — Host: процессов нет, Host поднимет сессии по resume.
func TestEt21_KeeperKilled_TreeGone(t *testing.T) {
	e := prepare(t)
	keeperPid := startKeeperProc(t, e.home)
	h := e.h.next(t)
	e.control(h)
	site, sitePid := e.spawn(h, "site")
	site.raw("child")
	grand := childPid(t, site.readLine())
	site.raw("sleep 60s")
	_, profPid := e.spawn(h, "profiles")

	killPid(t, keeperPid)
	eventually(t, "Host, claude и потомки завершились с keeper", func() bool {
		for _, p := range []int{h.Pid, sitePid, profPid, grand} {
			if alive(p) {
				return false
			}
		}
		return true
	})
	// служба ОС подняла keeper
	e.start()
	h2 := e.h.next(t)
	if h2.key == h.key {
		t.Fatal("ключ не сменился")
	}
	if l := e.control(h2).list(); len(l) != 0 {
		t.Fatalf("после перезапуска: %v", l)
	}
}
