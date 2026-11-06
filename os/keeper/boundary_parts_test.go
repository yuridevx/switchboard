package main

// Леса keeper, части машины: установка версии, смена и откат, остановка и force, пределы, падения и перезапуск, окружение, держатели частей
// на старте keeper. Источники свойств — в комментариях; без пометки — чьё: код.
import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Смена версии без наложения: новая стартует после выхода старой; part.updated; на диске — новая и предыдущая; откат на предыдущую — с
// диска, без скачивания: ссылки из плана живут час (план заморозки: «убрать версии, кроме текущей и предыдущей», «хранить на диске»; чьё:
// код — готовая версия — по метке).
func TestEtVersionSwitch(t *testing.T) {
	s := newStand(t)
	v1 := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.relay.setPlan(plan1(1, v1))
	k := s.start()
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	os.MkdirAll(verDir(s.home, "capture", "0.9.0"), 0o700) // версия позапрошлой выкладки
	// конверт кадра — протокола и relay: строгость keeper — к телу плана
	next := planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on))
	next["via"] = "relay"
	s.relay.push(next)
	waitFor(t, "1.4.0 running", running(k, "capture", "1.4.0"))
	waitFor(t, "part.updated", func() bool { return s.relay.ledgerHas("part.updated", "capture", "1.3.2", "1.4.0") })
	// новый план исполнен целиком: keeper.state и plan.json — rev 2
	var saved savedPlan
	b, _ := os.ReadFile(planFile(s.home))
	if jsonErr(b, &saved) || saved.Rev != 2 || stateOf(k).Rev != 2 {
		t.Fatalf("rev после кадра плана: plan.json %d, keeper.state %d", saved.Rev, stateOf(k).Rev)
	}
	// старая вышла сама после закрытого ввода («bye») раньше, чем стартовала новая
	waitFor(t, "строка старта 1.4.0", func() bool { return has(s.home, J{"line": sub("app 1.4.0 start")}) })
	if bye, start := index(s.home, J{"part": "capture", "line": "bye"}), index(s.home, J{"line": sub("app 1.4.0 start")}); bye < 0 || bye > start {
		t.Fatalf("наложение версий: bye=%d start=%d", bye, start)
	}
	if !isThere(verDir(s.home, "capture", "1.3.2")) {
		t.Fatal("предыдущая версия убрана — отката без скачивания не будет")
	}
	waitFor(t, "позапрошлая версия убрана", func() bool { return !isThere(verDir(s.home, "capture", "0.9.0")) })
	if got := dirNames(partFolder(s.home, "capture")); got != "1.3.2 1.4.0 data" {
		t.Fatalf("папки части: %v", got)
	}
	s.links.expire()
	s.relay.push(planMsg(3, v1))
	waitFor(t, "откат на 1.3.2", running(k, "capture", "1.3.2"))
	if count(s.home, J{"part": "capture", "ev": "installed", "version": "1.3.2"}) != 1 || !has(s.home, J{"part": "capture", "ev": "part_updated", "from": "1.4.0", "to": "1.3.2"}) {
		t.Fatal("откат не с диска или нет part_updated 1.4.0 → 1.3.2")
	}
	waitFor(t, "part.updated отката", func() bool { return s.relay.ledgerCount("part.updated", "capture") == 2 })
}

// dirNames — имена в папке через пробел.
func dirNames(dir string) string {
	es, _ := os.ReadDir(dir)
	var got []string
	for _, e := range es {
		got = append(got, e.Name())
	}
	return strings.Join(got, " ")
}

// Не выходит по закрытию ввода: stopping держится, и keeper ждёт её со всем остальным — упавшая другая часть ждёт в exited; force — держатель
// убивает дерево: и останавливаемую (мимо очереди), и работающую; после force другая часть перезапущена, если она в плане включена, и stopped,
// если выключена (план заморозки, «Чего не делаем»: «остановка ждёт выхода, force убивает»; дизайн: план исполняется после выхода; чьё: код —
// «нет в плане или выключена — stopped»).
func TestEtStubbornForce(t *testing.T) {
	for _, probeOn := range []bool{true, false} {
		s := newStand(t)
		a := s.links.part("capture", "1.3.2", appFiles("stubborn"), on)
		b := s.links.part("probe", "1.0.0", appFiles(""), on)
		s.relay.setPlan(plan1(1, a, b))
		k := s.start()
		waitFor(t, "обе running", func() bool { return running(k, "capture", "")() && running(k, "probe", "")() })
		aOff := s.links.part("capture", "1.3.2", appFiles("stubborn"), off)
		bNext := b
		if !probeOn {
			bNext = s.links.part("probe", "1.0.0", appFiles(""), off)
		}
		s.relay.push(planMsg(2, aOff, bNext))
		waitFor(t, "capture stopping", func() bool { return partOf(k, "capture").State == "stopping" })
		time.Sleep(time.Second)
		if partOf(k, "capture").State != "stopping" {
			t.Fatal("stopping держится до предела")
		}
		killPid(t, partOf(k, "probe").Pid)
		waitFor(t, "probe exited", func() bool { return partOf(k, "probe").State == "exited" })
		aOff["force"] = true
		s.relay.push(planMsg(3, aOff, bNext))
		waitFor(t, "capture stopped", func() bool { return partOf(k, "capture").State == "stopped" })
		if probeOn {
			waitFor(t, "probe перезапущена", func() bool { p := partOf(k, "probe"); return p.State == "running" && p.Restarts == 1 })
		} else {
			waitFor(t, "probe stopped", func() bool { return partOf(k, "probe").State == "stopped" })
			time.Sleep(700 * time.Millisecond)
			if p := partOf(k, "probe"); p.State != "stopped" || p.Restarts != 0 || count(s.home, J{"part": "probe", "ev": "part_start"}) != 1 {
				t.Fatalf("выключенная часть перезапущена: %+v", p)
			}
		}
		// force по работающей части — сразу, без ожидания закрытого ввода
		s.relay.push(planMsg(4, a, bNext))
		waitFor(t, "capture running снова", running(k, "capture", ""))
		s.relay.push(planMsg(5, aOff, bNext))
		waitFor(t, "capture stopped силой", func() bool { return partOf(k, "capture").State == "stopped" })
		waitFor(t, "два выхода силой", func() bool {
			return count(s.home, J{"part": "capture", "ev": "part_exit", "version": "1.3.2", "why": sub("SIGKILL")}) == 2
		})
	}
}

// 3123 · Часть не вышла за предел остановки после «закрой ввод» — строка stop_late с причиной, держатель убивает дерево, часть stopped; смена
// версии идёт дальше без рук (слово пользователя 2 нояб.: «у всех операций должен быть лимит и поддержка graceful shutdown»; устав: «не
// успела — жёсткий выход, это ожидаемая ветка»; факт — Host 1.1.56 на 4 машинах прода висел в stopping, снят руками).
func TestEtStopLimitKills(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("stubborn"), on)))
	k := s.startWith(tuning{stop: 1500 * time.Millisecond})
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "1.3.2 stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	time.Sleep(700 * time.Millisecond)
	if partOf(k, "capture").State != "stopping" {
		t.Fatal("до предела часть ещё останавливается штатно")
	}
	waitFor(t, "1.4.0 running после предела", running(k, "capture", "1.4.0"))
	if !has(s.home, J{"part": "capture", "kind": "stop", "ev": "stop_late", "why": sub("1.5s")}) || !has(s.home, J{"part": "capture", "ev": "part_exit", "version": "1.3.2", "why": sub("SIGKILL")}) {
		t.Fatal("нет строки stop_late или выхода силой\n" + journalAll(s.home))
	}
	if has(s.home, J{"ev": "part_failed"}) {
		t.Fatal("выход силой после предела — не падение части")
	}
}

// 3148 · Часть не вышла и после «убей» за предел — вторая строка stop_late, часть failed, новая версия не запущена (две версии разом нельзя);
// правка плана решает (слово пользователя 2 нояб.: «у всех операций должен быть лимит»).
func TestEtKillWaitLimit(t *testing.T) {
	s := newStand(t)
	os.MkdirAll(heldDir(s.home), 0o700)
	// процесс части — отдельный: уборка стенда убивает держателей по pid из их файлов
	child := exec.Command(self(), "app", "deaf")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { child.Process.Kill(); child.Wait() })
	putHeldFile(s.home, heldFile{ID: "capture", Owner: "keeper", Pid: child.Process.Pid, Port: deafHolder(t, child.Process.Pid), Key: "k", Tag: "1.3.2"})
	p1 := plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on))
	s.savePlan(p1)
	s.relay.setPlan(p1)
	k := s.startWith(tuning{stop: 700 * time.Millisecond})
	waitFor(t, "adopt", running(k, "capture", ""))
	s.online()
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "failed после «убей»", func() bool { return partOf(k, "capture").State == "failed" })
	if count(s.home, J{"part": "capture", "ev": "stop_late", "why": sub("700ms")}) != 2 || has(s.home, J{"ev": "part_start", "version": "1.4.0"}) {
		t.Fatal("нет stop_late после «закрой ввод» и после «убей» или новая версия запущена рядом с прежней\n" + journalAll(s.home))
	}
}

// Новая версия отклонена до остановки прежней — setup упал, чужое поле app.json, setup не уложился в предел, скачивание не уложилось в
// предел: прежняя работает с тем же pid, ошибка словом в keeper.state, part.failed в журнал флота; другие части плана исполняются; папки
// негодной версии нет (чьё: код — «версия годна, когда стоит и её app.json разобран: только тогда прежняя останавливается»; ревью архитектора
// 1 нояб.; слово пользователя 2 нояб.: «у всех операций должен быть лимит и поддержка graceful shutdown»).
func TestEtRejectedKeepsOld(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	childFile := filepath.Join(t.TempDir(), "child")
	t.Setenv("KEEPER_TEST_SETUP_CHILD", childFile)
	k := s.startWith(tuning{stop: 1500 * time.Millisecond, download: time.Second})
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	s.online()
	pid := partOf(k, "capture").Pid
	alien := appFiles("")
	alien["app.json"] = `{"run":["x"],"user":"admin"}`
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(60 * time.Second):
		}
	}))
	t.Cleanup(slow.Close)
	late := s.links.part("capture", "1.4.4", appFiles(""), on)
	late["url"] = slow.URL + "/capture/1.4.4.tgz"
	for i, c := range []struct {
		p          map[string]any
		word, fact string
	}{
		{s.links.part("capture", "1.4.1", appSetup("badsetup"), on), "setup_failed", "npm ERR! нет пакета"},
		{s.links.part("capture", "1.5.0", alien, on), "contract_mismatch", "user"},
		{s.links.part("capture", "1.4.3", appSetup("hangsetup"), on), "setup_failed", "1.5s"},
		{late, "download_failed", ""},
	} {
		probe := s.links.part("probe", fmt.Sprintf("1.0.%d", i), appFiles(""), on)
		s.relay.push(planMsg(2+i, c.p, probe))
		waitFor(t, c.word+" у работающей", func() bool {
			e := partOf(k, "capture").Error
			return strings.Contains(e, c.word) && strings.Contains(e, c.fact) && partOf(k, "probe").Version == probe["version"]
		})
		if p := partOf(k, "capture"); p.State != "running" || p.Version != "1.3.2" || p.Pid != pid {
			t.Fatalf("прежняя версия не работает: %+v", p)
		}
		waitFor(t, "part.failed "+c.word, func() bool { return s.relay.ledgerHas("part.failed", "capture", c.p["version"].(string), c.word) })
		if v := c.p["version"].(string); isThere(stampFile(verDir(s.home, "capture", v))) {
			t.Fatalf("негодная версия %s отмечена готовой", v)
		}
	}
	for _, v := range []string{"1.4.1", "1.5.0", "1.4.3"} {
		if isThere(verDir(s.home, "capture", v)) {
			t.Fatalf("папка негодной версии %s осталась", v)
		}
	}
	// setup снят по пределу вместе с потомками: иначе они держали бы папку версии
	b, _ := os.ReadFile(childFile)
	child, _ := strconv.Atoi(string(b))
	t.Cleanup(func() {
		if alive(child) {
			killPid(t, child)
		}
	})
	if child == 0 {
		t.Fatal("setup не записал pid потомка")
	}
	waitFor(t, "потомок setup снят", func() bool { return !alive(child) })
}

// 3158 · Новая версия не запустилась под держателем — прежняя уже остановлена штатно, часть failed «запуск: …», part.failed; в журнале машины
// hold_failed с причиной, файла о держателе нет; перезапуска нет; откат записи снимает failed (чьё: код; устав — система ловит, «дальше решает
// агент»).
func TestEtStartFails(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	s.online()
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", files{"app.json": `{"run":["switchboard-no-such-program"]}`}, on)))
	waitFor(t, "failed запуск", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.HasPrefix(p.Error, "запуск: ")
	})
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed", "capture", "1.4.0", "запуск") })
	if r := find(s.home, J{"ev": "hold_failed", "kind": "stop"}); r == nil || r["why"] == "" || r["why"] == nil {
		t.Fatalf("строка hold_failed %v", r)
	}
	if isThere(heldPath(s.home, "capture")) {
		t.Fatal("файл держателя остался")
	}
	if !has(s.home, J{"part": "capture", "line": "bye"}) {
		t.Fatal("прежняя версия не остановлена штатно до запуска новой")
	}
	time.Sleep(500 * time.Millisecond)
	if partOf(k, "capture").Restarts != 0 {
		t.Fatal("после failed — перезапуск")
	}
	s.relay.push(planMsg(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
	waitFor(t, "откат снимает failed", running(k, "capture", "1.3.2"))
}

// Приложение получает от keeper окружение машины и окружение из плана, рабочая папка процесса — data части; новое окружение в плане при той же
// версии — перезапуск с ним; запись части, которая не менялась, не трогается, когда меняется другая; тот же план с новой rev не трогает ничего
// (ревью архитектора 1 нояб.; устав: «обновление Host — по плану, сессии не останавливает»; чьё: код — «та же версия с тем же окружением —
// делать нечего», startPart, Cwd: data).
func TestEtEnvAndUnchanged(t *testing.T) {
	s := newStand(t)
	part := s.links.part("capture", "1.3.2", appFiles("env"), on)
	part["env"] = map[string]string{"SITE": "lab"}
	probe := s.links.part("probe", "1.0.0", appFiles(""), on)
	s.relay.setPlan(plan1(5, part, probe))
	k := s.start()
	waitFor(t, "обе running", func() bool { return running(k, "capture", "")() && running(k, "probe", "")() })
	waitFor(t, "строка env", func() bool { return has(s.home, J{"part": "capture", "line": sub("env ")}) })
	line, _ := find(s.home, J{"part": "capture", "line": sub("env ")})["line"].(string)
	data := filepath.Join(partFolder(s.home, "capture"), "data")
	for _, want := range []string{"SWITCHBOARD_MACHINE=win", "SWITCHBOARD_VERSION=1.3.2", "SWITCHBOARD_DATA=" + data, "SWITCHBOARD_HOME=" + s.home,
		"SWITCHBOARD_HOLDER=" + self(), "SWITCHBOARD_RELAY= ", "SWITCHBOARD_WORKERS={", "SITE=lab", "CWD=" + data} {
		if !strings.Contains(line, want) {
			t.Fatalf("нет %s в %q", want, line)
		}
	}
	pid, probePid := partOf(k, "capture").Pid, partOf(k, "probe").Pid
	withEnv := map[string]any{}
	for kk, v := range part {
		withEnv[kk] = v
	}
	withEnv["env"] = map[string]string{"SITE": "lab2"}
	s.relay.push(planMsg(6, withEnv, probe))
	waitFor(t, "перезапуск с новым окружением", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Pid != 0 && p.Pid != pid })
	waitFor(t, "часть видит новое окружение", func() bool { return has(s.home, J{"part": "capture", "line": sub("SITE=lab2")}) })
	if partOf(k, "probe").Pid != probePid || count(s.home, J{"part": "probe", "ev": "part_start"}) != 1 {
		t.Fatal("probe тронут планом, где её запись не менялась")
	}
	pid = partOf(k, "capture").Pid
	s.relay.push(planMsg(7, withEnv, probe))
	time.Sleep(500 * time.Millisecond)
	if p := partOf(k, "capture"); p.Pid != pid || p.State != "running" {
		t.Fatalf("тот же план с новой rev тронул часть: %+v", p)
	}
}

// Одно падение — один перезапуск, с диска: ссылка из плана живёт час; второе — failed и part.failed; та же запись плана failed не трогает;
// снимают его on: false → on: true и перезапуск keeper — часть запущена заново с одним перезапуском (устав, закрытый список: «умерла — один
// перезапуск, второе падение — failed, дальше решает агент (set on:false → on:true)»; решение плана заморозки 1 нояб.: failed живёт до
// перезапуска keeper).
func TestEtOneRestartThenFailed(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	same := s.links.part("capture", "1.3.2", appFiles(""), on)
	offP := s.links.part("capture", "1.3.2", appFiles(""), off)
	s.links.expire()
	crashTwice := func(k keeperHandle) {
		t.Helper()
		killPid(t, partOf(k, "capture").Pid)
		waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
		killPid(t, partOf(k, "capture").Pid)
		waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	}
	crashTwice(k)
	if !has(s.home, J{"part": "capture", "kind": "stop", "ev": "part_exit"}) {
		t.Fatal("нет строки о падении")
	}
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed", "capture", "1.3.2") })
	// та же запись части с новой rev — keeper failed не трогает: решает тот, кто правит план
	s.relay.push(planMsg(2, same))
	time.Sleep(700 * time.Millisecond)
	if partOf(k, "capture").State != "failed" {
		t.Fatal("failed поднят без правки плана")
	}
	s.relay.push(planMsg(3, offP))
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	s.relay.push(planMsg(4, same))
	waitFor(t, "running снова", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 0 })
	crashTwice(k)
	s.relay.setPlan(plan1(4, same))
	k.Stop()
	k2 := s.start()
	waitFor(t, "running после перезапуска keeper", func() bool { p := partOf(k2, "capture"); return p.State == "running" && p.Restarts == 0 })
}

// Выход без keeper — одно падение: держатель хранит код выхода, новый keeper получает его и поднимает часть; keeper вернулся после того, как
// держатель ушёл по пределу ожидания хозяина, — файла нет, часть запущена по плану заново без перезапуска и без part.failed (устав,
// закрытый список: «часть машины … умерла — один перезапуск»; чьё: код — выход без держателя не считается падением).
func TestEtExitWithoutKeeper(t *testing.T) {
	for _, unclaimed := range []bool{false, true} {
		wait := ""
		if unclaimed {
			wait = "300ms"
		}
		t.Setenv("KEEPER_TEST_OWNER_WAIT", wait)
		s := newStand(t)
		s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
		k := s.start()
		waitFor(t, "running", running(k, "capture", ""))
		pid := partOf(k, "capture").Pid
		k.Stop()
		killPid(t, pid)
		if unclaimed {
			waitFor(t, "held_unclaimed", func() bool { return has(s.home, J{"ev": "held_unclaimed"}) && !isThere(heldPath(s.home, "capture")) })
		} else {
			time.Sleep(300 * time.Millisecond)
		}
		k2 := s.start()
		restarts := 1
		if unclaimed {
			restarts = 0
		}
		waitFor(t, "часть поднята", func() bool {
			p := partOf(k2, "capture")
			return p.State == "running" && p.Restarts == restarts && p.Pid != pid && p.Pid != 0
		})
		if unclaimed && (count(s.home, J{"ev": "part_start"}) != 2 || s.relay.ledgerHas("part.failed")) {
			t.Fatalf("после ухода держателя: стартов %d, part.failed %v", count(s.home, J{"ev": "part_start"}), s.relay.ledgerHas("part.failed"))
		}
		if !unclaimed && !has(s.home, J{"part": "capture", "kind": "stop", "ev": "part_exit"}) {
			t.Fatal("нет строки о падении")
		}
	}
}

// Перезапуск keeper не трогает процессы: новый keeper подключается к держателю, pid тот же, вывод без keeper дочитан (устав, закрытый список:
// «keeper умер или подменил себя — …держатели живут, keeper подключается к своим»).
func TestEtKeeperRestartAdopts(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("chatty"), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	pid := partOf(k, "capture").Pid
	k.Stop()
	time.Sleep(200 * time.Millisecond) // часть пишет без keeper — держатель копит
	k2 := s.start()
	waitFor(t, "подключился", func() bool { p := partOf(k2, "capture"); return p.State == "running" && p.Pid == pid })
	if partOf(k2, "capture").Version != "1.3.2" {
		t.Fatal("версия держателя потеряна")
	}
	if r := find(s.home, J{"ev": "adopt", "id": "capture", "pid": pid}); r == nil || r["buffered"] == float64(0) || r["buffered"] == nil {
		t.Fatalf("строка adopt %v — накопленное без keeper не дочитано", r)
	}
}

// Старая версия упала, пока ставится новая: работает один экземпляр новой версии, перезапусков 0 (ревью 1 нояб.: было два экземпляра).
func TestEtCrashDuringInstall(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	old := partOf(k, "capture").Pid
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appSetup("slowsetup"), on)))
	waitFor(t, "setup идёт", func() bool { return isThere(filepath.Join(verDir(s.home, "capture", "1.4.0"), "setup-started")) })
	killPid(t, old)
	waitFor(t, "1.4.0 running", running(k, "capture", "1.4.0"))
	time.Sleep(time.Second) // выход старой версии разобран
	starts := count(s.home, J{"ev": "part_start", "version": "1.4.0"})
	if p := partOf(k, "capture"); starts != 1 || p.Restarts != 0 || p.State != "running" {
		t.Fatalf("стартов 1.4.0: %d, %+v", starts, p)
	}
}

// Сбой установки части, которая ещё не работает: failed со словом и part.failed в журнале флота — хэш не сошёлся, в архиве не файл и не папка,
// путь вне папки, app.json с чужим полем или без run, setup упал (тогда папки версии нет), нет app.json, имя версии с путём, нет ссылки,
// ссылка не отвечает; запись keeper с чужим хэшем — тот же сбой, keeper работает дальше; подпись ссылки не попадает ни в keeper.state, ни в
// журналы; остальной план исполнен (план заморозки: находки «Сбой установки части не доходит до журнала флота», «архив со ссылкой →
// download_failed», «чужое поле в app.json — отказ этой части»; устав, система ловит; опыт 5 нояб.: ошибка клиента HTTP несёт адрес целиком).
func TestEtInstallFailedToLedger(t *testing.T) {
	s := newStand(t)
	bad := s.links.part("capture", "1.0.0", appFiles(""), on)
	bad["sha256"] = strings.Repeat("0", 64)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	b, _ := json.Marshal(map[string]any{"run": []string{"x"}})
	tw.WriteHeader(&tar.Header{Name: "app.json", Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg})
	tw.Write(b)
	tw.WriteHeader(&tar.Header{Name: "link", Linkname: "app.json", Typeflag: tar.TypeSymlink})
	tw.Close()
	zw.Close()
	link := s.links.partTgz("probe", "1.0.0", buf.Bytes(), on)
	foreign := appFiles("")
	foreign["app.json"] = `{"run":["x"],"user":"admin"}`
	noApp := s.links.part("radar", "1.0.0", files{"main.cjs": "x"}, on)
	badName := s.links.part("sonar", "1.0.0", appFiles(""), on)
	badName["version"] = "1.0.0/../x"
	noRun := s.links.part("tuner", "1.0.0", files{"app.json": "{}"}, on)
	noLink := s.links.part("gauge", "1.0.0", appFiles(""), on)
	delete(noLink, "url")
	gone := s.links.part("dial", "1.0.0", appFiles(""), on)
	gone["url"] = gone["url"].(string) + "-нет"
	escape := s.links.part("relay", "1.0.0", files{"../x": "y"}, on)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().String()
	ln.Close()
	signed := s.links.part("pager", "1.0.0", appFiles(""), on)
	signed["url"] = "http://" + dead + "/pager.tgz?sig=SECRET"
	kp := s.links.part("keeper", "9.9.9", files{"x": "y"}, nil)
	kp["sha256"] = strings.Repeat("0", 64)
	s.relay.setPlan(plan1(1, bad, link, s.links.part("meter", "1.0.0", foreign, on), s.links.part("web", "1.0.0", appSetup("badsetup"), on), noApp,
		badName, noRun, noLink, gone, escape, signed, kp, s.links.part("clock", "1.0.0", appFiles(""), on)))
	k := s.start()
	for _, c := range []struct{ part, word, fact string }{
		{"capture", "download_failed", "sha256"},
		{"probe", "download_failed", "link"},
		{"relay", "download_failed", "../x"},
		{"meter", "contract_mismatch", "user"},
		{"tuner", "", "run"},
		{"web", "setup_failed", "npm ERR! нет пакета"},
		{"radar", "no_app_json", ""},
		{"sonar", "bad_plan", "1.0.0/../x"},
		{"gauge", "download_failed", "ссылки"},
		{"dial", "download_failed", "404"},
		{"pager", "download_failed", ""},
		{"keeper", "download_failed", ""},
	} {
		waitFor(t, c.part+" failed "+c.word, func() bool {
			p := partOf(k, c.part)
			return p.State == "failed" && strings.HasPrefix(p.Error, c.word) && strings.Contains(p.Error, c.fact)
		})
		if c.word != "" && c.part != "sonar" {
			waitFor(t, "part.failed "+c.part, func() bool { return s.relay.ledgerHas("part.failed", c.part, c.word) })
		}
	}
	waitFor(t, "остальной план исполнен", running(k, "clock", ""))
	notExited(t, k)
	if isThere(verDir(s.home, "web", "1.0.0")) {
		t.Fatal("папка версии с упавшим setup осталась")
	}
	if strings.Contains(partOf(k, "pager").Error, "SECRET") || strings.Contains(s.relay.ledgerText(), "SECRET") || strings.Contains(journalAll(s.home), "SECRET") {
		t.Fatalf("подпись ссылки наружу: %q", partOf(k, "pager").Error)
	}
}

// Часть убрана из плана: остановлена штатно и снята из keeper.state, папки версий убраны, data/ осталась.
func TestEtPartRemoved(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	keep := filepath.Join(partFolder(s.home, "capture"), "data", "keep")
	os.WriteFile(keep, []byte("1"), 0o600)
	s.relay.push(planMsg(2))
	waitFor(t, "снята", func() bool { return len(stateOf(k).Parts) == 0 })
	// папки версий keeper убирает после того, как снял часть из keeper.state
	waitFor(t, "папка версии убрана", func() bool { return !isThere(verDir(s.home, "capture", "1.3.2")) })
	if !isThere(keep) {
		t.Fatal("data/ убрана")
	}
	if !has(s.home, J{"part": "capture", "line": "bye"}) || !has(s.home, J{"part": "capture", "ev": "part_removed"}) {
		t.Fatal("часть не остановлена закрытием ввода или нет строки part_removed")
	}
}

// Остановка keeper, пока ставится новая версия: начатый setup доведён — ссылка на архив могла истечь, версия готова и сбоя нет; работающая
// живёт дальше с тем же pid; следующий keeper подключается к прежней версии и доводит переход с диска: прежняя вышла по закрытию ввода раньше
// старта новой, part_updated (ревью архитектора 1 нояб.: цикл доводил установку и гасил прежнюю версию; чьё: код — «Остановка keeper начатый
// setup доводит: следующему keeper не качать архив, ссылка на который могла истечь», «переход — у следующего keeper»).
func TestEtStopDuringInstallKeepsRunning(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	pid := partOf(k, "capture").Pid
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appSetup("slowsetup"), on)))
	waitFor(t, "setup идёт", func() bool { return isThere(filepath.Join(verDir(s.home, "capture", "1.4.0"), "setup-started")) })
	k.Stop()
	if !alive(pid) || has(s.home, J{"part": "capture", "line": "bye"}) {
		t.Fatal("работающая версия остановлена вместе с keeper")
	}
	if !isThere(stampFile(verDir(s.home, "capture", "1.4.0"))) || has(s.home, J{"ev": "part_failed"}) || s.relay.ledgerHas("part.failed") {
		t.Fatal("начатый setup не доведён или остановка принята за сбой\n" + journalAll(s.home))
	}
	s.links.expire()
	k2 := s.start()
	waitFor(t, "переход у следующего keeper", func() bool {
		p := partOf(k2, "capture")
		return p.State == "running" && p.Version == "1.4.0" && p.Restarts == 0
	})
	waitFor(t, "вывод новой версии в журнале", func() bool { return has(s.home, J{"line": sub("app 1.4.0 start")}) })
	bye, start := index(s.home, J{"part": "capture", "line": "bye"}), index(s.home, J{"line": sub("app 1.4.0 start")})
	if !has(s.home, J{"ev": "adopt", "id": "capture", "pid": pid, "version": "1.3.2"}) || bye < 0 || start < bye ||
		count(s.home, J{"ev": "installed", "version": "1.4.0"}) != 1 || !has(s.home, J{"ev": "part_updated", "from": "1.3.2", "to": "1.4.0"}) {
		t.Fatalf("переход у следующего keeper: adopt, bye=%d start=%d, установок 1.4.0 %d", bye, start, count(s.home, J{"ev": "installed", "version": "1.4.0"}))
	}
}

// Остановка keeper, пока упрямая прежняя версия выходит при смене версии: keeper не ждёт её и выходит с keeper_exit, новую версию не запускает
// — иначе две версии разом; прежняя живёт (чьё: код — «Остановка keeper прерывает ожидание»; устав: штатная остановка).
func TestEtStopDuringStubbornSwitch(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("stubborn"), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	pid := partOf(k, "capture").Pid
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles("stubborn"), on)))
	waitFor(t, "1.3.2 stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	start := time.Now()
	k.Stop()
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("остановка ждала упрямую часть %v", d)
	}
	if !has(s.home, J{"ev": "keeper_exit"}) || !alive(pid) || has(s.home, J{"ev": "part_start", "version": "1.4.0"}) {
		t.Fatal("нет keeper_exit, прежняя версия снята или новая запущена")
	}
}

// Остановка keeper прерывает зависшее скачивание: выход сразу, работающая версия жива, сбоя части нет (устав: «у всех операций лимит и
// graceful shutdown»; опыт 5 нояб.: остановка ждала зависшее скачивание, сколько сервер держал соединение, — 20 с, предел скачивания 10 мин).
func TestEtStopDuringDownload(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	s.online()
	pid := partOf(k, "capture").Pid
	hit := make(chan struct{}, 1)
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		hit <- struct{}{}
		select {
		case <-r.Context().Done():
		case <-time.After(30 * time.Second):
		}
	}))
	t.Cleanup(slow.Close)
	p := s.links.part("capture", "1.4.0", appFiles(""), on)
	p["url"] = slow.URL + "/x.tgz"
	s.relay.push(planMsg(2, p))
	<-hit
	start := time.Now()
	k.Stop()
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("остановка ждала скачивание %v", d)
	}
	if !alive(pid) || s.relay.ledgerHas("part.failed") || has(s.home, J{"kind": "stop", "ev": "install"}) || has(s.home, J{"ev": "part_failed"}) {
		t.Fatal("прерванное скачивание принято за сбой части или работающая версия снята")
	}
}

// Часть выключена с первого плана: stopped, процесса нет; включить — запуск; выключить — ввод закрыт, процесс вышел штатно, stopped; включить
// снова — с диска, без скачивания: ссылка из плана живёт час (план заморозки, «Жизнь части»: «остановка закрытием ввода»; «Установка
// версии»: «отметить папку»; чьё: код — «уже стоит из того же архива — без скачивания»; «выпуски» шлют on:false из плана машины).
func TestEtOffOn(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), off)))
	k := s.start()
	waitFor(t, "stopped с первого плана", func() bool { return partOf(k, "capture").State == "stopped" })
	if has(s.home, J{"ev": "part_start"}) {
		t.Fatal("выключенная часть запущена")
	}
	s.relay.push(planMsg(2, s.links.part("capture", "1.3.2", appFiles(""), on)))
	waitFor(t, "running", running(k, "capture", ""))
	pid := partOf(k, "capture").Pid
	offP := s.links.part("capture", "1.3.2", appFiles(""), off)
	back := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.links.expire()
	s.relay.push(planMsg(3, offP))
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	if !has(s.home, J{"part": "capture", "line": "bye"}) {
		t.Fatal("часть не остановлена закрытием ввода")
	}
	waitFor(t, "процесс вышел", func() bool { return !alive(pid) })
	s.relay.push(planMsg(4, back))
	waitFor(t, "running снова", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Pid != pid && p.Restarts == 0 })
	if n := count(s.home, J{"ev": "installed"}); n != 1 {
		t.Fatalf("установок %d — включение скачивало", n)
	}
}

// Умер держатель части — связь с ним оборвалась без кадра выхода: это падение части, один перезапуск с причиной; процесс ушёл вместе с
// держателем (устав, закрытый список: «умерла — один перезапуск»).
func TestEtHolderDiedPartRestarts(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	pid := partOf(k, "capture").Pid
	killPid(t, heldOf(s.home, "capture").Holder)
	waitFor(t, "один перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 && p.Pid != pid })
	if !has(s.home, J{"part": "capture", "kind": "stop", "ev": "part_exit", "why": sub("держател")}) {
		t.Fatal("нет строки о падении с причиной обрыва")
	}
	waitFor(t, "прежний процесс мёртв", func() bool { return !alive(pid) })
}

// Смена версии Host: часть с detach_children запустила держатель сессии — он и его процесс переживают выход прежней версии (устав:
// «обновление Host — по плану, сессии не останавливает»; «Процессы claude держит Host через свои держатели»).
func TestEtHostSwitchKeepsSessions(t *testing.T) {
	s := newStand(t)
	host := func(mode string) files {
		run := []string{self(), "app"}
		if mode != "" {
			run = append(run, mode)
		}
		b, _ := json.Marshal(map[string]any{"run": run, "detach_children": true})
		return files{"app.json": string(b)}
	}
	s.relay.setPlan(plan1(1, s.links.part("host", "1.0.0", host("host"), on)))
	k := s.start()
	waitFor(t, "держатель сессии", func() bool { return isThere(heldPath(s.home, "site@win")) })
	sess := heldOf(s.home, "site@win")
	s.relay.push(planMsg(2, s.links.part("host", "1.1.0", host(""), on)))
	waitFor(t, "1.1.0 running", running(k, "host", "1.1.0"))
	time.Sleep(500 * time.Millisecond)
	if !alive(sess.Pid) || !alive(sess.Holder) || !isThere(heldPath(s.home, "site@win")) {
		t.Fatal("смена версии Host сняла держатель сессии")
	}
}

// Перезапуск после падения не встал (версии нет на диске, ссылка истекла) — failed со словом и part.failed (устав: система ловит).
func TestEtRestartInstallFails(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	s.links.expire()
	if err := os.RemoveAll(verDir(s.home, "capture", "1.3.2")); err != nil {
		t.Fatal(err)
	}
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "failed", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.Contains(p.Error, "download_failed")
	})
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed", "capture", "1.3.2", "download_failed") })
}

// Последняя строка вывода без перевода строки доходит до журнала, когда процесс вышел: причина падения часто в ней (устав: «причина в
// журнале»; опыт 5 нояб.: строки в журнале не было, хвост stderr при этом пишется).
func TestEtOutputTailOnExit(t *testing.T) {
	s := newStand(t)
	b, _ := json.Marshal(map[string]any{"run": []string{self(), "tailapp"}})
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.0.0", files{"app.json": string(b)}, on)))
	k := s.start()
	waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	if !has(s.home, J{"part": "capture", "ev": "out", "line": "последние слова"}) {
		t.Fatal("хвост вывода пропал")
	}
}

// node из app.json — Node из keeper.json; npm — npm-cli.js рядом с ним под тем же Node: на Windows npm — это npm.cmd, а у службы может не быть
// PATH; путь, который есть в папке версии, — полный; setup идёт в папке версии, а не во временной: npm на Windows связывает пакеты workspaces
// ссылками с полным путём, после переименования временной папки Host не находил свои пакеты; run — в data части (чьё: дизайн «npm — npm
// рядом с ним»; живой прогон 1 нояб., win: ERR_MODULE_NOT_FOUND).
func TestEtNodeAndNpmFromConf(t *testing.T) {
	// npm рядом с Node на Windows и в ../lib/node_modules на Linux
	for _, cliDir := range []string{filepath.Join("bin", "node_modules"), filepath.Join("lib", "node_modules")} {
		nodeAndNpm(t, cliDir)
	}
}

func nodeAndNpm(t *testing.T, cliDir string) {
	s := newStand(t)
	d := t.TempDir()
	bin, _ := os.ReadFile(self())
	node := filepath.Join(d, "bin", binName("node"))
	os.MkdirAll(filepath.Dir(node), 0o755)
	os.WriteFile(node, bin, 0o755)
	cli := filepath.Join(d, cliDir, "npm", "bin", "npm-cli.js")
	os.MkdirAll(filepath.Dir(cli), 0o755)
	os.WriteFile(cli, nil, 0o644)
	saveConf(s.home, map[string]any{"node": node, "workers": map[string]any{"relay": "http" + strings.TrimPrefix(s.relay.url(), "ws"), "releases": s.relay.workerURL("releases"), "ledger": s.relay.workerURL("ledger")}})
	t.Setenv("KEEPER_TEST_NODE", filepath.Join(d, "calls"))
	s.relay.setPlan(plan1(1, s.links.part("web", "1.0.0", files{"app.json": `{"run":["node","main.cjs","x"],"setup":["npm","ci","--omit=dev"]}`, "main.cjs": "//"}, on)))
	k := s.start()
	waitFor(t, "running", running(k, "web", ""))
	dir := verDir(s.home, "web", "1.0.0")
	waitFor(t, "оба вызова", func() bool {
		b, _ := os.ReadFile(filepath.Join(d, "calls"))
		return strings.Count(string(b), "\n") == 2
	})
	b, _ := os.ReadFile(filepath.Join(d, "calls"))
	calls := strings.Split(strings.TrimSpace(string(b)), "\n")
	for i, c := range []struct{ args, cwd string }{{cli + "|ci|--omit=dev", dir}, {filepath.Join(dir, "main.cjs") + "|x", filepath.Join(partFolder(s.home, "web"), "data")}} {
		cut := strings.LastIndex(calls[i], "|")
		got, _ := os.Stat(calls[i][cut+1:])
		want, _ := os.Stat(c.cwd)
		if calls[i][:cut] != c.args || got == nil || want == nil || !os.SameFile(got, want) {
			t.Fatalf("вызов %d: %q, а надо %s в %s", i, calls[i], c.args, c.cwd)
		}
	}
}

// 5510 · Запуск держателя части под пределом: держатель стартует дольше 5 с — часть всё равно запущена (failed без перезапуска слишком дорог
// за занятую машину); держатель не прислал строку о себе за предел — запуск отказан с пределом в причине, держатель убит, файла о нём нет
// (слово пользователя 2 нояб.: «у всех операций лимит»; опыт 5 нояб.: под нагрузкой старт настоящего файла занял больше 5 с).
func TestEtHolderSpawnLimit(t *testing.T) {
	for _, silent := range []bool{false, true} {
		s := newStand(t)
		s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
		tn := tuning{}
		if silent {
			t.Setenv("KEEPER_TEST_HOLD_SILENT", "1")
			t.Setenv("KEEPER_TEST_HOLD_SLOW", "")
			tn.holderWait = 500 * time.Millisecond
		} else {
			t.Setenv("KEEPER_TEST_HOLD_SILENT", "")
			t.Setenv("KEEPER_TEST_HOLD_SLOW", "6s")
		}
		k := s.startWith(tn)
		if !silent {
			waitFor(t, "running", running(k, "capture", ""))
			continue
		}
		waitFor(t, "failed", func() bool {
			p := partOf(k, "capture")
			return p.State == "failed" && strings.Contains(p.Error, "500ms")
		})
		b, _ := os.ReadFile(filepath.Join(s.home, "silent-pid"))
		pid := 0
		fmt.Sscan(string(b), &pid)
		if pid == 0 {
			t.Fatal("молчащий держатель не записал pid")
		}
		waitFor(t, "молчащий держатель убит", func() bool { return !alive(pid) })
		if isThere(heldPath(s.home, "capture")) {
			t.Fatal("файл о держателе есть")
		}
	}
}

// Ничей держатель keeper на старте снят: процесс жив или уже вышел — orphan_kill, файл убран, держатель вышел, held_unclaimed нет, part_start
// нет (чьё: код — «Есть в плане — подключиться, нет — убить»; устав: «Keeper без решений… исполняет план»).
func TestEtOrphanHolder(t *testing.T) {
	for _, exited := range []bool{false, true} {
		s := newStand(t)
		f, err := holdProc(s.home, holdReq{ID: "old", Owner: "keeper", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=10s"), Cmd: []string{self(), "app"}})
		if err != nil {
			t.Fatal(err)
		}
		hf := heldOf(s.home, "old")
		if exited {
			killPid(t, f.Pid)
			waitFor(t, "процесс вышел", func() bool { return !alive(f.Pid) })
		}
		s.relay.setPlan(plan1(1))
		s.start()
		waitFor(t, "держатель вышел", func() bool { return !isThere(heldPath(s.home, "old")) && !alive(hf.Holder) && !alive(f.Pid) })
		if !has(s.home, J{"ev": "orphan_kill", "id": "old"}) || has(s.home, J{"ev": "held_unclaimed"}) || has(s.home, J{"ev": "part_start", "part": "old"}) {
			t.Fatal("ничей держатель снят не так")
		}
	}
}

// Держатели Host keeper не трогает: ни подключения, ни снятия; вышедший такой держатель уходит сам по пределу ожидания хозяина (устав: «Keeper
// без решений. Процессы claude держит Host через свои держатели»; ubuntu-db 3 нояб.).
func TestEtHostHoldersUntouched(t *testing.T) {
	for _, exited := range []bool{false, true} {
		s := newStand(t)
		f, err := holdProc(s.home, holdReq{ID: "site@win", Owner: "host", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=1s"), Cmd: []string{self(), "app"}})
		if err != nil {
			t.Fatal(err)
		}
		if exited {
			killPid(t, f.Pid)
		}
		s.relay.setPlan(plan1(1))
		k := s.start()
		waitFor(t, "план rev 1", func() bool { return stateOf(k).Rev == 1 })
		if exited {
			waitFor(t, "held_unclaimed", func() bool {
				return has(s.home, J{"ev": "held_unclaimed", "callsign": "site@win"}) && !isThere(heldPath(s.home, "site@win"))
			})
		} else {
			time.Sleep(700 * time.Millisecond)
			if !isThere(heldPath(s.home, "site@win")) || !alive(f.Pid) {
				t.Fatal("держатель Host тронут")
			}
		}
		if has(s.home, J{"ev": "adopt", "id": "site@win"}) || has(s.home, J{"ev": "orphan_kill", "id": "site@win"}) {
			t.Fatal("keeper взялся за держатель Host")
		}
	}
}

// Файл держателя, который не отвечает, — след прошлой жизни: файл убран, процессы по его номерам не трогаются — после перезагрузки эти номера чужие (чьё:
// код — «держатель не отвечает — файл убран»; находка сверки 6 нояб.).
func TestEtStaleHolderFile(t *testing.T) {
	s := newStand(t)
	stranger := exec.Command(self(), "app", "deaf")
	if err := stranger.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stranger.Process.Kill(); stranger.Wait() })
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	pid := stranger.Process.Pid
	putHeldFile(s.home, heldFile{ID: "old", Owner: "keeper", Pid: pid, Holder: pid, Port: port, Key: "k"})
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "план rev 1", func() bool { return stateOf(k).Rev == 1 })
	if isThere(heldPath(s.home, "old")) || !has(s.home, J{"ev": "adopt", "id": "old"}) {
		t.Fatal("файл держателя не убран\n" + journalAll(s.home))
	}
	time.Sleep(300 * time.Millisecond)
	if !alive(pid) {
		t.Fatal("убит чужой процесс по номеру из старого файла")
	}
}

// Откат на работающую версию после сбоя установки новой: процесс не тронут, ошибка снята (чьё: код — «alive && same»; находка сверки 6 нояб.).
func TestEtRollbackToRunning(t *testing.T) {
	s := newStand(t)
	v1 := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.relay.setPlan(plan1(1, v1))
	k := s.start()
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	s.online()
	pid := partOf(k, "capture").Pid
	bad := s.links.part("capture", "1.4.0", appFiles(""), on)
	bad["sha256"] = strings.Repeat("0", 64)
	s.relay.push(planMsg(2, bad))
	waitFor(t, "сбой 1.4.0", func() bool { return strings.Contains(partOf(k, "capture").Error, "download_failed") })
	s.relay.push(planMsg(3, v1))
	waitFor(t, "rev 3 и ошибка снята", func() bool { return stateOf(k).Rev == 3 && partOf(k, "capture").Error == "" })
	time.Sleep(500 * time.Millisecond)
	if p := partOf(k, "capture"); p.Pid != pid || p.State != "running" || count(s.home, J{"ev": "part_start"}) != 1 {
		t.Fatalf("откат на работающую версию тронул процесс: %+v", p)
	}
}

// Установка новой версии не удалась у работающей части — следующий план с той же записью пробует снова: сбой скачивания временный (чьё: код — работающая
// версия не та — версия ставится; находка сверки 6 нояб.).
func TestEtFailedUpdateRetried(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", running(k, "capture", "1.3.2"))
	s.online()
	good := s.links.part("capture", "1.4.0", appFiles(""), on)
	broken := map[string]any{}
	for n, v := range good {
		broken[n] = v
	}
	broken["url"] = good["url"].(string) + "-нет"
	s.relay.push(planMsg(2, broken))
	waitFor(t, "сбой скачивания", func() bool { return strings.Contains(partOf(k, "capture").Error, "download_failed") })
	s.relay.push(planMsg(3, good))
	waitFor(t, "1.4.0 со второго плана", running(k, "capture", "1.4.0"))
}

// Вышедшая сама ждёт цикл, занятый другой частью: причина выхода уже в keeper.state — экран машин показывает её (чьё: код — «err: причина failed или
// выхода»; находка сверки 6 нояб.).
func TestEtExitedShowsReason(t *testing.T) {
	s := newStand(t)
	a := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.relay.setPlan(plan1(1, a))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	s.online()
	s.relay.push(planMsg(2, a, s.links.part("probe", "1.0.0", appSetup("slowsetup"), on)))
	waitFor(t, "setup идёт", func() bool { return isThere(filepath.Join(verDir(s.home, "probe", "1.0.0"), "setup-started")) })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "exited", func() bool { return partOf(k, "capture").State == "exited" })
	if p := partOf(k, "capture"); p.Error == "" {
		t.Fatalf("причины выхода нет: %+v", p)
	}
	waitFor(t, "перезапуск снял причину", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Error == "" })
}

// on:false снимает счёт перезапусков: keeper.state выключенной части чистый (устав, закрытый список: «дальше решает агент (set on:false → on:true)»; чьё: код).
func TestEtOffClearsRestarts(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	s.online()
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	s.relay.push(planMsg(2, s.links.part("capture", "1.3.2", appFiles(""), off)))
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	if p := partOf(k, "capture"); p.Restarts != 0 {
		t.Fatalf("счёт перезапусков у выключенной: %+v", p)
	}
}

// Убранная из плана часть работает, пока ставятся записи плана, и видна в keeper.state; снимается после них (чьё: код — «execute: записи, снять убранные,
// подмена себя»; находка сверки 6 нояб.). keeper.state — по имени части.
func TestEtRemovedAfterEntries(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("zeta", "1.0.0", appFiles(""), on), s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "обе running", func() bool { return running(k, "zeta", "")() && running(k, "capture", "")() })
	s.online()
	if ps := stateOf(k).Parts; ps[0].Part != "capture" || ps[1].Part != "zeta" {
		t.Fatalf("порядок keeper.state: %+v", ps)
	}
	s.relay.push(planMsg(2, s.links.part("zeta", "1.0.0", appFiles(""), on), s.links.part("probe", "1.0.0", appSetup("slowsetup"), on)))
	waitFor(t, "setup идёт", func() bool { return isThere(filepath.Join(verDir(s.home, "probe", "1.0.0"), "setup-started")) })
	if p := partOf(k, "capture"); p.State != "running" {
		t.Fatalf("убранная снята раньше записей плана: %+v", p)
	}
	waitFor(t, "probe running", running(k, "probe", ""))
	waitFor(t, "убранная снята", func() bool { return partOf(k, "capture").State == "" })
}

// Журнал читают люди: значения без экранирования HTML (чьё: код — «encode — значение без экранирования HTML»; находка сверки 6 нояб.).
func TestEtJournalPlainText(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("<a&b>"), on)))
	k := s.start()
	waitFor(t, "running", running(k, "capture", ""))
	waitFor(t, "строка hold", func() bool { return has(s.home, J{"ev": "hold", "part": "capture"}) })
	ms, _ := filepath.Glob(filepath.Join(s.home, "journal", "*.jsonl"))
	b, _ := os.ReadFile(ms[0])
	if !strings.Contains(string(b), "<a&b>") {
		t.Fatalf("журнал с экранированием: %s", b)
	}
}
