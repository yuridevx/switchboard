package main

// Эталоны Keeper v2: одно свойство на зафиксированном входе. Время среди входов только там, где оно — свойство (ping, «закрой ввод»):
// тест его задаёт и ждёт факт. Остальное тест ждёт событием стенда — строкой журнала Keeper, запросом или соединением флоту, словом процесса,
// выходом процесса; «ничего не случилось» — после барьера, а не после паузы.
import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// План приходит одним путём: при подключении Keeper спрашивает сам, своим пропуском, с ОС; Host сборки запущен через держателя.
func TestConnectAsksPlanAndRunsHost(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "ok", nil))
	k := s.start()
	s.until("Host сборки 1 работает", func() bool { return running(k, 1)() && s.f.hellosN() > 0 })
	if n := s.f.asksN(); n != 1 {
		t.Fatalf("вопросов о плане %d, ждали 1", n)
	}
	s.f.mu.Lock()
	ask, auth, hello := s.f.asks[0], s.f.auth[0], s.f.hellos[0]
	s.f.mu.Unlock()
	if ask["os"] != runtime.GOOS || ask["id"] == "" || ask["trace"] == "" {
		t.Fatalf("кадр builds.plan: %v", ask)
	}
	if auth != "Bearer "+testKey {
		t.Fatalf("пропуск в запросе: %q", auth)
	}
	if hello["type"] != "hello" || hello["role"] != "keeper" || hello["proto"] != float64(2) || hello["key"] != testKey || hello["path"] != "/m/home/win" {
		t.Fatalf("hello: %v", hello)
	}
	s.until("Host записал своё окружение", func() bool { return s.f.saidHas("env") })
	env := hostEnv(s.home)
	data := filepath.Join(s.home, "host", "data")
	if env["SB_HOME"] != s.home || env["SB_FLEET"] != "home" || env["SB_MACHINE"] != "win" || env["SB_BUILD"] != "1" || env["SB_DATA"] != data ||
		env["SB_BASE"] != s.f.srv.URL || env["SB_HOLDER"] == "" {
		t.Fatalf("окружение Host: %v", env)
	}
	if env["main"] != filepath.Join(s.home, "host", "1", "src", "main.ts") {
		t.Fatalf("Host запущен не из папки сборки: %v", env["main"])
	}
	if h, ok := heldOf(s.home, "host"); !ok || h.Owner != "keeper" || h.Tag != "1" {
		t.Fatalf("держатель Host: %+v", h)
	}
}

// План исполняется с диска без сети: адреса флота не достать — Host сохранённой сборки запущен.
func TestSavedPlanRunsWithoutNetwork(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "ok", nil))
	k := s.start()
	s.until("Host сборки 1 работает", running(k, 1))
	k.Stop()
	old, _ := heldOf(s.home, "host")
	killHolders(s.home) // возврат — когда Host и держатель вышли
	asks := s.f.asksN()
	s.conf("http://127.0.0.1:1") // флота нет
	k2 := s.start()
	s.until("Host сборки 1 поднят с диска", func() bool { return s.n("host_start") == 2 })
	if h, ok := heldOf(s.home, "host"); !running(k2, 1)() || !ok || h.Pid == old.Pid {
		t.Fatalf("Host с диска: %+v, был pid %d", h, old.Pid)
	}
	if s.f.asksN() != asks {
		t.Fatal("Keeper без сети дошёл до флота")
	}
}

// plan.changed — «спроси план»: кадр без данных ведёт к запросу builds.plan и к смене сборки; в журнале флота — host.updated.
func TestPlanChangedLeadsToPlanRequest(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "ok", nil))
	k := s.start()
	s.until("Host сборки 1 работает", running(k, 1))
	old, _ := heldOf(s.home, "host")
	s.f.setPlan(s.f.hostPlan(2, "ok", nil))
	// план у флота другой, а вопрос о плане был один — при подключении
	if stateOf(k).Host.Build != 1 || s.f.asksN() != 1 {
		t.Fatal("Keeper узнал о плане без кадра plan.changed")
	}
	s.f.push(map[string]any{"type": "plan.changed", "from": ".builds"})
	s.until("Host сборки 2 работает", running(k, 2))
	if n := s.f.asksN(); n != 2 {
		t.Fatalf("вопросов о плане %d, ждали 2", n)
	}
	// новый Host запускается после выхода прежнего
	if alive(old.Pid) {
		t.Fatal("прежний Host не вышел")
	}
	s.until("host.updated в журнале флота", func() bool { return s.f.ledgerHas("host.updated", "1 → 2") })
	// прежняя сборка остаётся на диске до следующей смены
	s.f.setPlan(s.f.hostPlan(3, "ok", nil))
	s.f.push(map[string]any{"type": "plan.changed"})
	s.until("Host сборки 3 работает", running(k, 3))
	s.planned() // смена на 3 доделана: папки убраны
	if fileExists(filepath.Join(s.home, "host", "1")) || !fileExists(filepath.Join(s.home, "host", "2")) {
		t.Fatal("папка сборки 1 не убрана или убрана папка сборки 2")
	}
}

// Сборка флоту не назначена (план null): Keeper ничего не ставит и не падает.
func TestNullPlanDoesNothing(t *testing.T) {
	s := newStand(t)
	k := s.start()
	s.until("строка plan_none", func() bool { return s.n("plan_none") > 0 })
	if v := stateOf(k); v.Host.State != "stopped" || v.Host.Build != 0 {
		t.Fatalf("состояние: %+v", v)
	}
}

// Первое падение Host — один перезапуск с диска; Host работает дальше.
func TestFirstCrashRestartsOnce(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "crashonce", nil))
	k := s.start()
	s.until("Host поднят после падения", func() bool { return s.n("host_start") == 2 })
	if !running(k, 1)() || s.n("host_failed") > 0 {
		t.Fatal("одно падение записано как failed")
	}
}

// Второе падение Host — failed; Keeper остаётся на связи и отвечает состоянием по договору; в журнале флота — host.failed.
func TestSecondCrashFailsAndKeeperAnswers(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "crash", nil))
	k := s.start()
	s.until("Host failed", func() bool { return s.n("host_failed") > 0 })
	if n := s.n("host_start"); n != 2 || stateOf(k).Host.State != "failed" {
		t.Fatalf("запусков Host %d, ждали 2; состояние %+v", n, stateOf(k))
	}
	s.until("host.failed в журнале флота", func() bool { return s.f.ledgerHas("host.failed", "второе падение") })
	if s.n("host_exit") == 0 {
		t.Fatal("падение Host не записано в журнал машины (host_exit)")
	}
	r := s.f.ask(map[string]any{"type": "keeper.state", "id": "q1", "trace": "t-77", "to": ".keeper@win", "from": "pult~a@b.c"})
	if r["id"] != "q1" || r["ok"] != true || r["trace"] != "t-77" {
		t.Fatalf("ответ: %v", r)
	}
	spans, _ := r["spans"].([]any)
	if len(spans) != 1 || spans[0].(map[string]any)["part"] != "keeper" {
		t.Fatalf("отрезок пути: %v", r["spans"])
	}
	res := r["result"].(map[string]any)
	h := res["host"].(map[string]any)
	if h["state"] != "failed" || h["build"] != float64(1) || !strings.Contains(h["why"].(string), "второе падение") || res["os"] != osName() || res["build"] != float64(0) {
		t.Fatalf("состояние: %v", res)
	}
	// тот же план ещё раз — failed остаётся: решает новая сборка
	s.planned() // тот же план
	s.planned() // барьер: план выше исполнен
	if stateOf(k).Host.State != "failed" || s.n("host_start") != 2 {
		t.Fatal("тот же план поднял упавший Host")
	}
	s.f.setPlan(s.f.hostPlan(2, "ok", nil))
	s.f.push(map[string]any{"type": "plan.changed"})
	s.until("другая сборка работает", running(k, 2))
}

// Перезапуск Host по запросу: та же сборка, новый процесс; упавший Host поднимается тем же запросом; в состоянии — pid Host и сборка плана.
func TestHostRestartOnRequest(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "ok", nil))
	k := s.start()
	s.until("Host работает", running(k, 1))
	st := s.f.ask(map[string]any{"type": "keeper.state", "id": "q0"})["result"].(map[string]any)
	pid := st["host"].(map[string]any)["pid"]
	if pid == nil || pid == float64(0) || st["plan"] != float64(1) {
		t.Fatalf("в состоянии нет pid Host или сборки плана: %v", st)
	}
	if r := s.f.ask(map[string]any{"type": "host.restart", "id": "q1"}); r["ok"] != true {
		t.Fatalf("ответ: %v", r)
	}
	s.until("Host запущен заново", func() bool { return s.n("host_restart") > 0 })
	if !running(k, 1)() || s.n("host_start") != 2 {
		t.Fatalf("после перезапуска: запусков %d, состояние %+v", s.n("host_start"), stateOf(k))
	}
	st = s.f.ask(map[string]any{"type": "keeper.state", "id": "q2"})["result"].(map[string]any)
	if st["host"].(map[string]any)["pid"] == pid {
		t.Fatal("процесс Host тот же после перезапуска")
	}
	s.until("host.restarted в журнале флота", func() bool { return s.f.ledgerHas("host.restarted", "перезапущен") })
}

// Незнакомый запрос — отказ словом.
func TestUnknownRequestRefused(t *testing.T) {
	s := newStand(t)
	s.start()
	s.until("на связи", s.f.online)
	r := s.f.ask(map[string]any{"type": "shell.run", "id": "q2"})
	if r["ok"] != false || r["error"] != "unknown_request" {
		t.Fatalf("ответ: %v", r)
	}
}

// Подмена Host не трогает держателей сессий: процесс сессии и его держатель те же после смены сборки.
func TestHostSwapKeepsSessionHolders(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "session", nil))
	k := s.start()
	s.until("Host сборки 1 работает", running(k, 1))
	s.until("держатель сессии", func() bool { return s.f.saidHas("session") })
	sess, _ := heldOf(s.home, "site@win")
	old, _ := heldOf(s.home, "host")
	s.f.setPlan(s.f.hostPlan(2, "session", nil))
	s.f.push(map[string]any{"type": "plan.changed"})
	s.until("Host сборки 2 работает", running(k, 2))
	if alive(old.Pid) {
		t.Fatal("прежний Host не вышел")
	}
	now, ok := heldOf(s.home, "site@win")
	if !ok || now.Pid != sess.Pid || now.Holder != sess.Holder || !alive(sess.Pid) || !alive(sess.Holder) {
		t.Fatalf("держатель сессии: был %+v, стал %+v", sess, now)
	}
	// сессия отвечает новому хозяину
	o, _ := attachHeld(t, now)
	defer o.c.Close()
	putFrame(o.c, 'i', []byte("ping\n"))
	if out, _ := o.read("echo ping"); !strings.Contains(out, "echo ping") {
		t.Fatalf("сессия не ответила: %q", out)
	}
}

// Штатная остановка Keeper: Host живёт у держателя; новый Keeper подключается к нему и второй раз не запускает.
func TestStopLeavesHostAndNextKeeperAdopts(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "ok", nil))
	k := s.start()
	s.until("Host сборки 1 работает", running(k, 1))
	h, _ := heldOf(s.home, "host")
	k.Stop()
	if !alive(h.Pid) || !alive(h.Holder) {
		t.Fatal("остановка Keeper сняла Host")
	}
	var last map[string]any
	for _, r := range records(s.home) {
		if r["module"] == "keeper" {
			last = r
		}
	}
	if last["msg"] != "keeper_exit" {
		t.Fatalf("последняя строка Keeper в журнале: %v", last)
	}
	k2 := s.start()
	s.until("новый Keeper видит Host", running(k2, 1))
	s.until("план спрошен", func() bool { return s.f.asksN() == 2 })
	s.planned() // барьер: сохранённый план и план флота исполнены
	if now, _ := heldOf(s.home, "host"); now.Pid != h.Pid || s.n("host_start") != 1 || s.n("adopt") == 0 {
		t.Fatalf("Host перезапущен: был pid %d, стал %d", h.Pid, now.Pid)
	}
}

// Самоподмена: файл Keeper в плане другой — он скачан, сверен, ответил номером сборки плана, свой файл подменён, Keeper вышел; Host живёт.
func TestSelfUpdate(t *testing.T) {
	s := newStand(t)
	target := filepath.Join(t.TempDir(), exe("keeper"))
	os.WriteFile(target, []byte("прежний файл"), 0o755)
	next, _ := os.ReadFile(self())
	p := s.f.hostPlan(2, "ok", nil)
	p["keeper"] = map[string]any{"url": s.f.srv.URL + "/files/keeper", "sha256": sha(next)}
	s.f.locked(func() { s.f.files["keeper"] = next })
	s.f.setPlan(p)
	t.Setenv("KEEPER_TEST_VERSION", "2")
	tn := fast
	tn.self = func() (string, error) { return target, nil }
	k := s.startWith(tn)
	waitChan(t, "Keeper вышел после подмены", k.Done())
	if got, _ := fileSha(target); got != sha(next) {
		t.Fatal("свой файл не подменён")
	}
	if olds, _ := filepath.Glob(target + ".*.old"); len(olds) != 1 {
		t.Fatalf("прежний файл: %v", olds)
	}
	// остановка ждёт запись журнала флота: последняя перед выходом доходит
	if s.n("self_update") == 0 || !s.f.ledgerHas("keeper.updated", "→ 2") {
		t.Fatal("подмена не записана: " + journalText(s.home))
	}
	h, ok := heldOf(s.home, "host")
	if !ok || !alive(h.Pid) {
		t.Fatal("подмена Keeper сняла Host")
	}
	// новый Keeper: тот же файл — подмены нет, прежний файл убран на старте, Host тот же
	k2 := s.startWith(tn)
	if olds, _ := filepath.Glob(target + ".*.old"); len(olds) != 0 {
		t.Fatalf("прежний файл не убран: %v", olds)
	}
	s.until("новый Keeper видит Host", running(k2, 2))
	s.until("план спрошен", func() bool { return s.f.asksN() == 2 })
	s.planned() // барьер: план исполнен, подмена — его последний шаг
	if s.n("keeper_exit") != 1 {
		t.Fatal("Keeper подменил себя тем же файлом")
	}
}

// Новый файл Keeper ответил не той сборкой — подмены нет, Keeper работает, сбой в журнале флота.
func TestSelfUpdateRefusesWrongBuild(t *testing.T) {
	s := newStand(t)
	target := filepath.Join(t.TempDir(), exe("keeper"))
	os.WriteFile(target, []byte("прежний файл"), 0o755)
	next, _ := os.ReadFile(self())
	p := s.f.hostPlan(2, "ok", nil)
	p["keeper"] = map[string]any{"url": s.f.srv.URL + "/files/keeper", "sha256": sha(next)}
	s.f.locked(func() { s.f.files["keeper"] = next })
	s.f.setPlan(p)
	t.Setenv("KEEPER_TEST_VERSION", "7")
	tn := fast
	tn.self = func() (string, error) { return target, nil }
	k := s.startWith(tn)
	s.until("keeper.failed в журнале флота", func() bool { return s.f.ledgerHas("keeper.failed", "check_failed") })
	if b, _ := os.ReadFile(target); string(b) != "прежний файл" {
		t.Fatal("файл подменён сборкой, которая себя не подтвердила")
	}
	if !running(k, 2)() {
		t.Fatal("Host не работает")
	}
}

// Пропуск отозван: флот закрывает соединение словом — Keeper останавливает связь и больше не стучится; сохранённый план исполняется.
func TestRevokedPassStopsKnocking(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "ok", nil))
	k := s.start()
	s.until("Host сборки 1 работает", running(k, 1))
	k.Stop()
	hellos := s.f.hellosN()
	s.f.locked(func() { s.f.closeWith = "revoked" })
	k2 := s.start()
	// link_stopped пишется, когда связь встала: после неё подключений нет
	s.until("связь остановлена", func() bool { return s.n("link_stopped") > 0 || s.f.hellosN()-hellos > 1 })
	if n := s.f.hellosN() - hellos; n != 1 {
		t.Fatalf("подключений после отзыва %d, ждали 1", n)
	}
	s.until("Host сохранённого плана работает", running(k2, 1))
}

// Пропуск не принят на запросе плана — то же: связь остановлена.
func TestBadKeyOnPlanStopsLink(t *testing.T) {
	s := newStand(t)
	s.f.locked(func() { s.f.planRefuse = "bad_key" })
	s.start()
	// link_stopped пишется, когда связь встала: после неё подключений и вопросов нет
	s.until("связь остановлена", func() bool {
		return s.n("link_stopped") > 0 && s.f.hellosN() > 0 || s.f.hellosN() > 1 || s.f.asksN() > 1
	})
	if s.f.hellosN() != 1 || s.f.asksN() != 1 {
		t.Fatalf("Keeper стучится: подключений %d, вопросов %d", s.f.hellosN(), s.f.asksN())
	}
}

// Обрыв соединения — ожидаемая ветка: Keeper подключается снова и снова спрашивает план.
func TestReconnectAsksPlanAgain(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "ok", nil))
	k := s.start()
	s.until("Host сборки 1 работает", running(k, 1))
	s.f.setPlan(s.f.hostPlan(2, "ok", nil))
	s.f.mu.Lock()
	c := s.f.conn
	s.f.conn = nil
	s.f.mu.Unlock()
	c.CloseNow()
	s.until("Host сборки 2 после переподключения", func() bool { return running(k, 2)() && s.f.hellosN() >= 2 })
	if s.f.hellosN() != 2 {
		t.Fatalf("подключений %d, ждали 2", s.f.hellosN())
	}
}

// Молчаливый обрыв (слово пользователя 16 нояб.: ping 10 с у всех компонентов): pong держит соединение; флот перестал отвечать pong,
// хотя кадры шлёт, — до второго ping соединение признано мёртвым, Keeper подключается снова. Срок — вход теста: ping задаёт тест, факт —
// какой ping ушёл по соединению последним.
func TestSilentLinkReconnects(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "ok", nil))
	s.f.locked(func() { s.f.pongs = 1 }) // pong — на первый ping; на второй — кадр вместо pong
	tn := fast
	tn.ping = time.Second
	s.startWith(tn)
	s.until("новое подключение после молчания, прежнее дочитано", func() bool {
		s.f.mu.Lock()
		defer s.f.mu.Unlock()
		return len(s.f.conns) > 0 && s.f.conns[0].pings > 2 || len(s.f.conns) >= 2 && s.f.conns[0].over
	})
	s.f.mu.Lock()
	pings := s.f.conns[0].pings
	s.f.mu.Unlock()
	// второй ping ушёл — pong на первый держит соединение; третьего нет — ping без pong замечен к следующему ping, хотя кадр пришёл
	if pings != 2 {
		t.Fatalf("ping по первому соединению %d, ждали 2", pings)
	}
	if !s.line("link_closed", "нет ответа на ping") {
		t.Fatal("соединение закрыто не по молчанию: " + journalText(s.home))
	}
}

// Архив не тот, что в плане: сборка не ставится, работающий Host работает дальше с причиной.
func TestBadArchiveKeepsRunningHost(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "ok", nil))
	k := s.start()
	s.until("Host сборки 1 работает", running(k, 1))
	p := s.f.hostPlan(2, "ok", nil)
	p["host"].(map[string]any)["sha256"] = strings.Repeat("0", 64)
	s.f.setPlan(p)
	s.f.push(map[string]any{"type": "plan.changed"})
	s.until("сбой записан", func() bool { return s.f.ledgerHas("host.failed", "sha256") })
	v := stateOf(k)
	if v.Host.State != "running" || v.Host.Build != 1 || !strings.Contains(v.Host.Why, "download_failed") {
		t.Fatalf("состояние: %+v", v)
	}
	if fileExists(filepath.Join(s.home, "host", "2")) {
		t.Fatal("папка несверенной сборки осталась")
	}
}

// В архиве есть package-lock.json — перед запуском идёт npm ci в папке сборки, под Node из keeper.json.
func TestNpmCiWhenLockPresent(t *testing.T) {
	s := newStand(t)
	// Node с npm рядом: копия тестового файла и npm-cli.js
	dir := t.TempDir()
	node := filepath.Join(dir, exe("node"))
	if err := copyFile(node, self()); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(dir, "node_modules", "npm", "bin", "npm-cli.js")
	os.MkdirAll(filepath.Dir(cli), 0o700)
	os.WriteFile(cli, nil, 0o644)
	b, _ := json.Marshal(map[string]any{"base": s.f.srv.URL, "machine": "win", "node": node})
	os.WriteFile(filepath.Join(s.home, "keeper.json"), b, 0o600)
	s.f.setPlan(s.f.hostPlan(1, "ok", map[string]string{"package-lock.json": "{}"}))
	k := s.start()
	s.until("Host сборки 1 работает", running(k, 1))
	if got, _ := os.ReadFile(filepath.Join(s.home, "host", "1", "npm-ran")); string(got) != "ci" {
		t.Fatalf("npm ci не запускался: %q", got)
	}
	s.f.setPlan(s.f.hostPlan(2, "ok", nil))
	s.f.push(map[string]any{"type": "plan.changed"})
	s.until("Host сборки 2 работает", running(k, 2))
	if fileExists(filepath.Join(s.home, "host", "2", "npm-ran")) {
		t.Fatal("npm ci запущен без package-lock.json")
	}
}

// Host не слушает конец ввода — держатель убивает его за предел, новая сборка встаёт.
func TestDeafHostKilledOnSwap(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "deaf", nil))
	tn := fast
	tn.stop = 500 * time.Millisecond
	k := s.startWith(tn)
	s.until("Host сборки 1 работает", running(k, 1))
	old, _ := heldOf(s.home, "host")
	s.f.setPlan(s.f.hostPlan(2, "ok", nil))
	s.f.push(map[string]any{"type": "plan.changed"})
	s.until("Host сборки 2 работает", running(k, 2))
	if alive(old.Pid) || s.n("stop_late") == 0 {
		t.Fatal("глухой Host не убит")
	}
}

// Журнал — строки одной формы с остальными частями: t в мс, level, part keeper, module, msg, флот и машина.
func TestJournalLineForm(t *testing.T) {
	s := newStand(t)
	// Host печатает строку и падает: держатель пишет его вывод в журнал раньше, чем отдаёт выход, — строка host_exit идёт после
	s.f.setPlan(s.f.hostPlan(1, "crashonce", nil))
	s.start()
	s.until("Host вышел", func() bool { return s.n("host_exit") > 0 })
	mods, out := map[string]bool{}, false
	for _, r := range records(s.home) {
		ts, _ := r["t"].(float64)
		lvl, _ := r["level"].(string)
		if ts < 1.7e12 || (lvl != "info" && lvl != "warn" && lvl != "error") || r["part"] != "keeper" || r["msg"] == "" || r["fleet"] != "home" || r["machine"] != "win" {
			t.Fatalf("строка журнала: %v", r)
		}
		mods[r["module"].(string)] = true
		out = out || r["msg"] == "out"
	}
	if !mods["keeper"] || !mods["holder"] || !out {
		t.Fatalf("модули журнала: %v, вывод Host: %v", mods, out)
	}
}

/* ===== Установка ===== */

func installStand(t *testing.T) (*fleet, string) {
	f := newFleet(t)
	root := t.TempDir()
	t.Setenv("USERPROFILE", root)
	t.Setenv("HOME", root)
	setFleet("")
	t.Cleanup(func() { setFleet("") })
	return f, filepath.Join(root, ".switchboard2", "home")
}

// Установка: флот — из приглашения, redeem — без пропуска; на диске пропуск, адрес флота, имя машины из ответа и файл keeper.
func TestInstallPreparesMachine(t *testing.T) {
	f, home := installStand(t)
	f.redeem = func(in map[string]any) map[string]any {
		if in["invite"] != "home:i7x2q9:abcdefabcdefabcdefab" {
			return map[string]any{"ok": false, "error": "bad_key"}
		}
		return map[string]any{"result": map[string]any{"key": testKey, "addr": "@laptop"}}
	}
	dst, err := prepareMachine([]string{"--base", f.srv.URL + "/"}, bufio.NewReader(strings.NewReader("home:i7x2q9:abcdefabcdefabcdefab\n")))
	if err != nil {
		t.Fatal(err)
	}
	if f.auth[0] != "" {
		t.Fatalf("redeem ушёл с пропуском: %q", f.auth[0])
	}
	if key, fleet := machineKey(home); key != testKey || fleet != "home" {
		t.Fatalf("machine.key: %q %q", key, fleet)
	}
	c, _ := readConf(home)
	if c.Base != f.srv.URL || c.Machine != "laptop" || c.Node == "" {
		t.Fatalf("keeper.json: %+v", c)
	}
	if dst != filepath.Join(home, exe("keeper")) || !fileExists(dst) {
		t.Fatalf("файл keeper: %s", dst)
	}
	if serviceName() != "switchboard2-keeper-home" || strings.Join(runArgs(), " ") != "run --name home" {
		t.Fatalf("служба: %s %v", serviceName(), runArgs())
	}
}

// Отказ приглашению, приглашение не машины, приглашение чужого флота — словом; на диске ничего.
func TestInstallRefusals(t *testing.T) {
	f, home := installStand(t)
	run := func(args []string, in string) error {
		setFleet("")
		_, err := prepareMachine(args, bufio.NewReader(strings.NewReader(in)))
		return err
	}
	base := []string{"--base", f.srv.URL}
	f.redeem = func(map[string]any) map[string]any { return map[string]any{"ok": false, "error": "bad_key", "why": "приглашение истекло"} }
	if err := run(base, "home:i7x2q9:abcdefabcdefabcdefab\n"); err == nil || !strings.Contains(err.Error(), "bad_key") {
		t.Fatalf("отказ флота: %v", err)
	}
	f.redeem = func(map[string]any) map[string]any {
		return map[string]any{"result": map[string]any{"key": testKey, "addr": "pult~a@b.c"}}
	}
	if err := run(base, "home:i7x2q9:abcdefabcdefabcdefab\n"); err == nil || !strings.Contains(err.Error(), "не машины") {
		t.Fatalf("приглашение устройства: %v", err)
	}
	if err := run(base, "просто строка\n"); err == nil || !strings.Contains(err.Error(), "флот:номер:секрет") {
		t.Fatalf("не приглашение: %v", err)
	}
	if err := run([]string{"--base", "ftp://x"}, "home:i7x2q9:abcdefabcdefabcdefab\n"); err == nil {
		t.Fatal("адрес флота не https")
	}
	setFleet("work")
	if _, err := prepareMachine(base, bufio.NewReader(strings.NewReader("home:i7x2q9:abcdefabcdefabcdefab\n"))); err == nil || !strings.Contains(err.Error(), "--name work") {
		t.Fatalf("чужой флот: %v", err)
	}
	if fileExists(filepath.Join(home, "machine.key")) || fileExists(filepath.Join(home, "keeper.json")) {
		t.Fatal("отказ оставил файлы на диске")
	}
}

/* ===== Держатель ===== */

// Держатель: вывод копится без хозяина, ввод доходит, после закрытия ввода — кадр выхода с кодом; хозяин забрал выход — держатель вышел.
func TestHolderProtocol(t *testing.T) {
	home := t.TempDir()
	t.Cleanup(func() { killHolders(home) })
	f := newFleet(t)
	h, exited := holdApp(t, home, "site@win", "host", "KEEPER_TEST_SAID="+f.srv.URL+"/said")
	// вывод до первого хозяина: процесс записал больше трубы — держатель прочитал начало без хозяина
	f.b.until(t, "процесс напечатал", func() bool { return f.saidHas("printed") })
	o, hello := attachHeld(t, h)
	if hello.Pid != h.Pid || hello.Buffered == 0 {
		t.Fatalf("hello: %+v, файл: %+v", hello, h)
	}
	if out, _ := o.read("app start"); !strings.Contains(out, "app start") {
		t.Fatalf("накопленный вывод: %q", out)
	}
	putFrame(o.c, 'i', []byte("раз\n"))
	if out, _ := o.read("echo раз"); !strings.Contains(out, "echo раз") {
		t.Fatalf("эхо: %q", out)
	}
	putFrame(o.c, 'c', nil)
	out, exit := o.read("")
	if exit == nil || exit.Code == nil || *exit.Code != 0 || !strings.Contains(out, "bye") {
		t.Fatalf("выход: %+v, вывод %q", exit, out)
	}
	o.c.Close()
	waitChan(t, "держатель вышел", exited)
}

// Новый хозяин вытесняет прежнего; «убей» — выход с сигналом.
func TestHolderOwnerReplacedAndKill(t *testing.T) {
	home := t.TempDir()
	t.Cleanup(func() { killHolders(home) })
	h, _ := holdApp(t, home, "site@win", "host")
	first, _ := attachHeld(t, h)
	first.read("app start")
	second, _ := attachHeld(t, h)
	defer second.c.Close()
	if _, err := first.c.Read(make([]byte, 1)); err == nil || os.IsTimeout(err) {
		t.Fatalf("прежний хозяин не вытеснен: %v", err)
	}
	putFrame(second.c, 'k', nil)
	_, exit := second.read("")
	if exit == nil || exit.Signal == nil || *exit.Signal != "SIGKILL" {
		t.Fatalf("выход после «убей»: %+v", exit)
	}
	if alive(h.Pid) {
		t.Fatal("процесс жив после «убей»")
	}
}

// Чужой ключ — отказ словом.
func TestHolderRefusesBadKey(t *testing.T) {
	home := t.TempDir()
	t.Cleanup(func() { killHolders(home) })
	h, _ := holdApp(t, home, "site@win", "host")
	bad := h
	bad.Key = "00"
	c, err := dialHolder(bad)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(testDeadline(t))
	putFrame(c, 'a', []byte(bad.Key))
	typ, b, _ := getFrame(c)
	if typ != 'e' || string(b) != "bad_key" {
		t.Fatalf("ответ на чужой ключ: %c %s", typ, b)
	}
}

/* ===== Архив ===== */

// Путь архива наружу папки сборки — отказ.
func TestUnpackRefusesPathOutside(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "build")
	if err := unpack(tgz(map[string]string{"../evil.txt": "x"}), dir); err == nil || !strings.Contains(err.Error(), "вне папки") {
		t.Fatalf("распаковка наружу: %v", err)
	}
	if fileExists(filepath.Join(filepath.Dir(dir), "evil.txt")) {
		t.Fatal("файл записан вне папки сборки")
	}
}

// Упавший Host поднимается запросом host.restart, и счёт падений сброшен: следующее падение снова даёт один перезапуск, а не сразу failed.
// Источник: устав — «второе падение — failed, дальше решает агент»; договор host.restart — «упавший — поднять».
func TestHostRestartRaisesFailedAndResetsCrashCount(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "crash", nil))
	k := s.start()
	s.until("Host failed", func() bool { return s.n("host_failed") == 1 })
	if n := s.n("host_start"); n != 2 {
		t.Fatalf("запусков Host до failed %d, ждали 2", n)
	}
	if r := s.f.ask(map[string]any{"type": "host.restart", "id": "q1"}); r["ok"] != true {
		t.Fatalf("ответ: %v", r)
	}
	// запрос поднял Host (третий запуск); он упал — один перезапуск (четвёртый); упал снова — failed: после этой строки актор ничего не ждёт
	s.until("после запроса — запуск, перезапуск и failed", func() bool { return s.n("host_failed") == 2 || s.n("host_start") > 4 })
	if n := s.n("host_start"); n != 4 || stateOf(k).Host.State != "failed" {
		t.Fatalf("запусков Host %d, ждали 4: счёт падений не сброшен или перезапусков больше одного", n)
	}
}

// Перезапуск Host по запросу не трогает держателей сессий: процесс сессии и его держатель те же, Host — новый процесс той же сборки.
// Источник: договор host.restart — «сессии живут в держателях»; устав — «Keeper … сессии не останавливает».
func TestHostRestartKeepsSessionHolders(t *testing.T) {
	s := newStand(t)
	s.f.setPlan(s.f.hostPlan(1, "session", nil))
	k := s.start()
	s.until("Host работает", running(k, 1))
	s.until("держатель сессии", func() bool { return s.f.saidHas("session") })
	sess, _ := heldOf(s.home, "site@win")
	old, _ := heldOf(s.home, "host")
	if r := s.f.ask(map[string]any{"type": "host.restart", "id": "q1"}); r["ok"] != true {
		t.Fatalf("ответ: %v", r)
	}
	s.until("Host запущен заново", func() bool { return s.n("host_restart") > 0 })
	// новый Host запускается после выхода прежнего
	if !running(k, 1)() || s.n("host_start") != 2 || alive(old.Pid) {
		t.Fatalf("перезапуск: запусков %d, прежний pid %d жив: %v", s.n("host_start"), old.Pid, alive(old.Pid))
	}
	now, ok := heldOf(s.home, "site@win")
	if !ok || now.Pid != sess.Pid || now.Holder != sess.Holder || !alive(sess.Pid) || !alive(sess.Holder) {
		t.Fatalf("держатель сессии: был %+v, стал %+v", sess, now)
	}
}
