package main

// Леса keeper, план и связь: вопрос о плане, кадр плана, отказы, связь с relay, keeper.state, остановка keeper. Снаружи — поддельные relay,
// «Выпуски», журнал флота и gate; части и держатели — настоящие процессы этого тестового файла. Источники свойств — в комментариях; без
// пометки — чьё: код.
import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Поставить по плану: при подключении keeper спрашивает план у «выпусков», архив скачан по ссылке, хэш сверен, держатель запускает run из
// app.json в папке data/, ответ сохранён в plan.json (план заморозки: «Спросить при подключении… хранить на диске»; «Скачать по ссылке,
// сверить sha256, распаковать, выполнить setup, отметить папку»).
func TestEtPlanInstallAndRun(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "capture running", running(k, "capture", ""))
	// вопрос — по контракту с «выпусками»: releases.plan v1 на .releases с id
	if q := s.relay.firstAsk(); q["type"] != "releases.plan" || q["v"] != float64(1) || q["to"] != ".releases" || q["id"] == "" || q["id"] == nil {
		t.Fatalf("вопрос о плане %v", q)
	}
	p := partOf(k, "capture")
	if p.Version != "1.3.2" || p.Pid == 0 {
		t.Fatalf("state %+v", p)
	}
	if !isThere(filepath.Join(s.home, "parts", "capture", "data")) || !isThere(stampFile(verDir(s.home, "capture", "1.3.2"))) {
		t.Fatal("нет папки версии или data/")
	}
	waitFor(t, "вывод в журнале", func() bool { return has(s.home, J{"part": "capture", "line": sub("app 1.3.2 start")}) })
	var saved savedPlan
	b, _ := os.ReadFile(planFile(s.home))
	if jsonErr(b, &saved) || saved.Rev != 1 || len(saved.Parts) != 1 || saved.Parts[0].Version != "1.3.2" {
		t.Fatalf("plan.json — не ответ «выпусков»: %s", b)
	}
}

// Обрыв связи с relay — keeper переподключается к relay своей машины (/m/<машина> из пропуска) тем же hello и спрашивает план снова POST
// «Выпускам» пропуском машины, в том числе когда обрыв пришёлся на ожидание ответа; тот же план, в том числе кадром, части не трогает; новый
// план после переподключения исполняется (устав, закрытый список: «соединение… оборвалось — клиенты переподключаются»; дизайн «Открытый
// флот»; чьё: код — «при каждом подключении: вопрос о плане», «Та же rev — переподключение»).
func TestEtRelayDropReasks(t *testing.T) {
	s := newStand(t)
	s.relay.setSilent(1)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "первый вопрос", func() bool { return s.relay.planAsks() == 1 })
	s.relay.drop()
	waitFor(t, "план со второго вопроса", running(k, "capture", ""))
	pid := partOf(k, "capture").Pid
	s.relay.drop()
	waitFor(t, "вопрос после переподключения", func() bool { return s.relay.planAsks() == 3 })
	time.Sleep(500 * time.Millisecond)
	s.relay.push(planMsg(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	time.Sleep(500 * time.Millisecond)
	hello, opens := s.relay.seen()
	if opens != 3 || hello["key"] != "host.win.ab12.sig" || hello["proto"] != float64(1) || hello["part"] != "keeper" {
		t.Fatalf("hello %v, входов %d", hello, opens)
	}
	s.relay.mu.Lock()
	path, keys := s.relay.path, append([]string(nil), s.relay.keys...)
	s.relay.mu.Unlock()
	if path != "/m/win" || len(keys) == 0 || keys[0] != "host.win.ab12.sig" {
		t.Fatalf("путь relay %q, пропуска POST %v", path, keys)
	}
	if p := partOf(k, "capture"); p.Pid != pid || p.Restarts != 0 || p.State != "running" {
		t.Fatalf("переподключение тронуло часть: %+v", p)
	}
	if count(s.home, J{"ev": "plan", "rev": 1, "word": absent}) != 1 || has(s.home, J{"word": "old_rev"}) ||
		count(s.home, J{"ev": "relay_open"}) != 3 || !has(s.home, J{"ev": "relay_closed"}) {
		t.Fatal("строки журнала о переподключении: нужны relay_open ×3, relay_closed, одна строка plan, без old_rev")
	}
	// план поменялся, пока keeper не был на связи: после переподключения — новая rev
	s.relay.setPlan(plan1(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	s.relay.drop()
	waitFor(t, "1.4.0 после переподключения", running(k, "capture", "1.4.0"))
	if !has(s.home, J{"ev": "plan", "rev": 2}) {
		t.Fatal("нет строки plan rev 2")
	}
}

// Ответ на вопрос о плане — не план (молчание за предел, отказ словом, не план v1): строка refuse со словом, исполняется сохранённый план,
// соединение с relay не рвётся и вопрос не повторяется; план приходит кадром releases.plan (отчёт слепого архитектора 2 нояб., пункт 7 —
// лишняя коммуникация: повтор через переподключение; план заморозки, контракт «план машины v1»: «чужое поле или v≠1 — отказ»; устав:
// система ловит, «ошибки — словами»).
func TestEtPlanReplyNotPlan(t *testing.T) {
	for _, c := range []struct {
		word string
		set  func(s *stand)
	}{
		{"timeout", func(s *stand) { s.relay.setSilent(1) }},
		{"cf_failed", func(s *stand) { s.relay.setRefuse("cf_failed") }},
		{"contract_mismatch", func(s *stand) {
			extra := s.links.part("capture", "1.4.0", appFiles(""), on)
			extra["args"] = []string{"--x"}
			s.relay.setPlan(plan1(4, extra))
		}},
	} {
		s := newStand(t)
		s.savePlan(plan1(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
		c.set(s)
		k := s.startWith(tuning{planWait: 500 * time.Millisecond})
		waitFor(t, "отказ "+c.word, func() bool { return has(s.home, J{"kind": "refuse", "ev": "plan", "word": c.word}) })
		waitFor(t, "сохранённый план", running(k, "capture", "1.3.2"))
		if stateOf(k).Rev != 3 {
			t.Fatalf("%s: исполнен не сохранённый план: %+v", c.word, stateOf(k))
		}
		if c.word == "cf_failed" && !has(s.home, J{"word": "cf_failed", "why": sub("cf_failed")}) {
			t.Fatal("нет причины отказа")
		}
		s.relay.push(planMsg(5, s.links.part("capture", "1.3.2", appFiles(""), on), s.links.part("probe", "1.0.0", appFiles(""), on)))
		waitFor(t, "план кадром", running(k, "probe", ""))
		if _, opens := s.relay.seen(); opens != 1 || s.relay.planAsks() != 1 {
			t.Fatalf("%s: hello %d, вопросов %d — keeper переподключался или переспрашивал", c.word, opens, s.relay.planAsks())
		}
	}
}

// Кадр плана отклонён и не исполняется: не от .releases — bad_from; чужое поле части или v≠1 — contract_mismatch; rev старше исполняемого —
// old_rev; у каждого строка refuse с причиной (план заморозки, контракт «план машины v1»: «чужое поле или v≠1 — отказ»; эталон «План не от
// «выпусков» не исполняется»; чьё: код — «меньшая — «выпуски» потеряли счёт: такой план не исполняется, строка в журнале»).
func TestEtPlanFrameRejected(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(5))
	k := s.start()
	waitFor(t, "план rev 5", func() bool { return stateOf(k).Rev == 5 })
	foreign := planMsg(6, s.links.part("capture", "1.0.0", appFiles(""), on))
	foreign["from"] = "phone~x@y"
	extra := s.links.part("capture", "1.0.0", appFiles(""), on)
	extra["args"] = []string{"--x"}
	v2 := planMsg(8, s.links.part("capture", "1.0.0", appFiles(""), on))
	v2["v"] = 2
	for _, f := range []map[string]any{foreign, planMsg(7, extra), v2, planMsg(3, s.links.part("capture", "1.0.0", appFiles(""), on))} {
		s.relay.push(f)
	}
	waitFor(t, "четыре отказа", func() bool {
		return count(s.home, J{"word": "bad_from"}) == 1 && count(s.home, J{"word": "contract_mismatch"}) == 2 && count(s.home, J{"word": "old_rev"}) == 1
	})
	for _, w := range []J{{"word": "bad_from", "why": sub("phone~x@y")}, {"word": "old_rev", "why": sub("5")}} {
		if !has(s.home, w) {
			t.Fatalf("нет причины %v", w)
		}
	}
	if stateOf(k).Rev != 5 || partOf(k, "capture").State != "" {
		t.Fatalf("отклонённый план исполнен: %+v", stateOf(k))
	}
}

// Планы пришли, пока цикл занят установкой: исполняется старший rev, младший пропущен без строки old_rev (чьё: код — «из ожидающих берётся
// с большей rev»).
func TestEtPlanQueueTakesNewest(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "rev 1", func() bool { return stateOf(k).Rev == 1 })
	a := s.links.part("capture", "1.0.0", appSetup("slowsetup"), on)
	s.relay.push(planMsg(2, a))
	waitFor(t, "setup идёт", func() bool { return isThere(filepath.Join(verDir(s.home, "capture", "1.0.0"), "setup-started")) })
	if st := partOf(k, "capture").State; st != "stopped" {
		t.Fatalf("новая часть, пока ставится: %q", st)
	}
	s.relay.push(planMsg(4, a, s.links.part("probe", "1.0.0", appFiles(""), on)))
	s.relay.push(planMsg(3, a, s.links.part("meter", "1.0.0", appFiles(""), on)))
	waitFor(t, "probe running", running(k, "probe", ""))
	time.Sleep(500 * time.Millisecond)
	var saved savedPlan
	b, _ := os.ReadFile(planFile(s.home))
	jsonErr(b, &saved)
	if stateOf(k).Rev != 4 || saved.Rev != 4 || partOf(k, "meter").State != "" || has(s.home, J{"word": "old_rev"}) {
		t.Fatalf("rev %d, plan.json %d, meter %+v", stateOf(k).Rev, saved.Rev, partOf(k, "meter"))
	}
}

// Связь с relay: недоступен или не принял hello — keeper повторяет подключение с паузой от первой вдвое до предела, отказ hello паузу не
// сбрасывает и причина его в журнале; принял hello, но на ping молчит — соединение мёртвое: закрывает и подключается снова, пауза после
// принятого hello снова первая (устав, закрытый список: «соединение… оборвалось — клиенты переподключаются»; факт: сеть WSL теряет пакеты;
// чьё: код — «roster — знак, что hello принят», «нет pong к следующему — соединение мёртвое», «от 1 с, вдвое до 60 с»).
func TestEtRelayReconnects(t *testing.T) {
	var mu sync.Mutex
	tries, hellos := 0, 0
	var at []time.Time  // начало каждой попытки
	var ended time.Time // конец принятого соединения
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		tries++
		n := tries
		at = append(at, time.Now())
		mu.Unlock()
		if n <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable) // relay ещё не поднялся
			return
		}
		ws, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		ctx := context.Background()
		if _, _, err := ws.Read(ctx); err != nil {
			return
		}
		if n <= 4 {
			ws.Close(websocket.StatusPolicyViolation, "bad_key")
			return
		}
		mu.Lock()
		hellos++
		mu.Unlock()
		ws.Write(ctx, websocket.MessageText, []byte(`{"type":"roster"}`))
		for {
			if _, _, err := ws.Read(ctx); err != nil { // ping читается, pong не уходит
				mu.Lock()
				if ended.IsZero() {
					ended = time.Now()
				}
				mu.Unlock()
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	home := relayHome(t, srv.URL)
	bootOn(t, home, tuning{ping: 100 * time.Millisecond, pauseFirst: 50 * time.Millisecond, pauseMax: time.Second})
	waitFor(t, "второе подключение после молчания на ping", func() bool { mu.Lock(); defer mu.Unlock(); return hellos >= 2 })
	mu.Lock()
	defer mu.Unlock()
	if n := count(home, J{"ev": "relay_closed"}); n < 5 {
		t.Fatalf("закрытых подключений %d", n)
	}
	if refused := index(home, J{"ev": "relay_closed", "why": sub("bad_key")}); refused < 0 || index(home, J{"ev": "relay_open"}) < refused {
		t.Fatal("нет причины отказа hello или relay_open раньше принятого hello")
	}
	for i, min := range []time.Duration{50, 100, 200, 400} {
		if gap := at[i+1].Sub(at[i]); gap < min*time.Millisecond {
			t.Fatalf("пауза после неудачи %d — %v, меньше %v мс", i+1, gap, min)
		}
	}
	if gap := at[5].Sub(ended); gap > 500*time.Millisecond {
		t.Fatalf("после принятого hello пауза %v — не сброшена к первой", gap)
	}
}

// keeper отвечает состояние сам, без Host; незнакомый запрос — отказ словом.
func TestEtKeeperState(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	r := s.relay.ask(map[string]any{"type": "keeper.state", "to": ".keeper@win"})
	if r["ok"] != true {
		t.Fatalf("ответ %v", r)
	}
	res := r["result"].(map[string]any)
	if res["keeper"] != ourVersion || res["rev"].(float64) != 3 || res["os"] == "" || res["os"] == nil {
		t.Fatalf("ответ %v", res)
	}
	ps := res["parts"].([]any)
	if len(ps) != 1 {
		t.Fatalf("части %v", ps)
	}
	// часть в ответе — по контракту keeper.state v1: part, version, state, pid, restarts
	if p := ps[0].(map[string]any); p["part"] != "capture" || p["version"] != "1.3.2" || p["state"] != "running" ||
		p["pid"] != float64(partOf(k, "capture").Pid) || p["restarts"] != float64(0) {
		t.Fatalf("часть %v", p)
	}
	if r["to"] != "~test" {
		t.Fatal("ответ не тому, кто спросил")
	}
	// незнакомый запрос — отказ словом (устав: «ошибки — словами»)
	if u := s.relay.ask(map[string]any{"type": "keeper.nope", "to": ".keeper@win"}); u["ok"] != false || u["error"] != "unknown_request" {
		t.Fatalf("ответ на незнакомый запрос %v", u)
	}
}

// Адреса «Выпусков» и журнала нет в keeper.json или журнал не отвечает: строки с причиной в журнале машины, сохранённый план исполняется,
// запись журнала флота — строкой ledger в журнале машины (устав: система ловит — пишет с причиной; чьё: код — «не дошла — только в журнал
// машины»).
func TestEtNoWorkerAddress(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().String()
	ln.Close()
	for _, c := range []struct {
		workers func(s *stand) map[string]any
		ledger  string
	}{
		{func(s *stand) map[string]any {
			return map[string]any{"relay": "http" + strings.TrimPrefix(s.relay.url(), "ws")}
		}, "workers.ledger"},
		{func(*stand) map[string]any {
			return map[string]any{"relay": "http://" + dead, "ledger": "http://" + dead + "/ledger"}
		}, "offline"},
	} {
		s := newStand(t)
		saveConf(s.home, map[string]any{"workers": c.workers(s)})
		s.savePlan(plan1(1, s.links.part("capture", "1.0.0", files{"app.json": `{"run":["switchboard-no-such-program"]}`}, on)))
		k := s.start()
		waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
		waitFor(t, "строка ledger "+c.ledger, func() bool {
			return has(s.home, J{"ev": "ledger", "event": "part.failed", "why": sub(c.ledger)})
		})
		if c.ledger == "workers.ledger" {
			waitFor(t, "строка о «Выпусках»", func() bool { return has(s.home, J{"why": sub("workers.releases")}) })
		}
	}
}

// Журнал флота не отвечает — цикл частей его не ждёт: запись идёт своей горутиной, следующая часть поднята сразу; остановка ждёт запись не дольше
// предела запроса (чьё: код — «ledger — строка в журнал флота своей горутиной: цикл частей не ждёт»).
func TestEtLedgerDoesNotHoldCycle(t *testing.T) {
	s := newStand(t)
	release := make(chan struct{})
	s.relay.hang = release
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.0.0", files{"app.json": `{"run":["switchboard-no-such-program"]}`}, on), s.links.part("probe", "1.0.0", appFiles(""), on)))
	k := s.start()
	t.Cleanup(func() { close(release) })
	start := time.Now()
	waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	waitFor(t, "следующая часть", running(k, "probe", ""))
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("цикл ждал журнал флота %v", d)
	}
}

// Штатная остановка keeper, пока вопрос о плане ждёт ответа: выход сразу, связь с relay закрыта кадром закрытия и keeper больше не подключается; keeper_exit
// — последняя его строка в журнале, после остановки он не пишет; держатель и процесс части живут (устав: «Каждая часть… останавливается
// штатно: …закрывает соединения… → выходит», «держатели живут»; находка пользователя 1 нояб.: CI на ubuntu — «journal: directory not empty»
// при уборке после Stop; чьё: код — остановка прерывает ожидание).
func TestEtStopKeeper(t *testing.T) {
	s := newStand(t)
	s.relay.setSilent(5)
	s.savePlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("chatty"), on)))
	k := s.start()
	waitFor(t, "вывод идёт", func() bool { return has(s.home, J{"line": "tick 20"}) })
	waitFor(t, "вопрос в пути", func() bool { return s.relay.planAsks() == 1 })
	pid := partOf(k, "capture").Pid
	start := time.Now()
	k.Stop()
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("остановка ждала ответ на вопрос %v", d)
	}
	if !alive(pid) || !isThere(heldPath(s.home, "capture")) {
		t.Fatal("остановка keeper остановила часть")
	}
	time.Sleep(1500 * time.Millisecond)
	if _, opens := s.relay.seen(); opens != 1 {
		t.Fatalf("после остановки keeper подключился снова: входов %d", opens)
	}
	s.relay.mu.Lock()
	closed := s.relay.closed
	s.relay.mu.Unlock()
	if closed != websocket.StatusNormalClosure {
		t.Fatalf("связь закрыта не штатно: %v", closed)
	}
	if l := lastKeeperLine(s.home); l["ev"] != "keeper_exit" {
		t.Fatalf("последняя строка keeper после остановки: %v", l)
	}
}

// Перезагрузка без связи: файл держателя, который принял соединение и молчит, убран за предел 5 с с причиной, старт не висит; keeper
// исполняет сохранённый план (план заморозки: «хранить на диске и исполнять без связи»; слово пользователя 2 нояб.: «у всех операций должен
// быть лимит»; устав, система ловит — строки с причиной).
func TestEtSavedPlanWithoutRelay(t *testing.T) {
	s := newStand(t)
	s.savePlan(plan1(7, s.links.part("capture", "1.3.2", appFiles(""), on)))
	saveConf(s.home, map[string]any{}) // relay нет
	// процесс части — отдельный: уборка стенда убивает процессы по pid из файлов держателей
	child := exec.Command(self(), "app", "deaf")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { child.Process.Kill(); child.Wait() })
	putHeldFile(s.home, heldFile{ID: "capture", Owner: "keeper", Pid: child.Process.Pid, Port: silentHolder(t), Key: "k", Tag: "1.3.2"})
	start := time.Now()
	k := s.start()
	waitFor(t, "running без связи", running(k, "capture", ""))
	if d := time.Since(start); d > 15*time.Second {
		t.Fatalf("старт ждал молчащего держателя %v", d)
	}
	for _, want := range []J{{"kind": "stop", "ev": "relay", "why": sub("workers.relay")}, {"ev": "adopt", "id": "capture", "why": sub("5s")},
		{"ev": "plan", "rev": 7}, {"ev": "part_start", "part": "capture", "version": "1.3.2"}} {
		if !has(s.home, want) {
			t.Fatalf("нет строки %v", want)
		}
	}
}

// 3171 · Битый plan.json — строка stop с причиной, держатели частей сняты как ничьи, keeper живёт и поднимает части по плану «выпусков» заново.
func TestEtBrokenPlanOrphans(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	pid := partOf(k, "capture").Pid
	k.Stop()
	os.WriteFile(planFile(s.home), []byte("{битый"), 0o600)
	k2 := s.start()
	if !has(s.home, J{"kind": "stop", "ev": "plan", "why": sub("plan.json")}) {
		t.Fatal("нет строки о битом plan.json")
	}
	waitFor(t, "часть поднята заново", func() bool { p := partOf(k2, "capture"); return p.State == "running" && p.Pid != pid })
	if !has(s.home, J{"ev": "orphan_kill", "id": "capture"}) {
		t.Fatal("держатель части не снят как ничей")
	}
}

// 3172 · keeper.json не прочитан — старт отказан: код 1, «keeper: …» в stderr, строка stop keeper_start с причиной; держатели частей не
// тронуты (устав: система ловит — «останавливает, отказывает, пишет в журнал с причиной»).
func TestEtBadConfRefused(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	pid := partOf(k, "capture").Pid
	k.Stop()
	os.WriteFile(confFile(s.home), []byte("{битый"), 0o600)
	code, _, stderr := runKeeper(t, s.home, "", "run")
	if code != 1 || !strings.Contains("\n"+stderr, "\nkeeper: ") || !alive(pid) {
		t.Fatalf("код %d, stderr %q, часть жива %v", code, stderr, alive(pid))
	}
	if !has(s.home, J{"kind": "stop", "ev": "keeper_start", "why": sub("keeper.json")}) {
		t.Fatal("нет строки keeper_start с причиной")
	}
}
