package main

// Эталоны keeper — исполнителя плана, и держателя. Источники свойств — дизайн «Выпуски флота» (слово пользователя
// 1 нояб.: состояние машины спускается сверху, keeper исполняет и отвечает состояние, держатели) и замеры 1 нояб.
import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
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

var on = map[string]any{"on": true}

// Поставить по плану: при подключении keeper спрашивает план у «выпусков», архив скачан по ссылке, хэш сверен, держатель
// запускает run из app.json в папке data/, ответ сохранён в plan.json (план заморозки: «Спросить при подключении…
// хранить на диске»; «Скачать по ссылке, сверить sha256, распаковать, выполнить setup, отметить папку»).
func TestEtPlanInstallAndRun(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "capture running", func() bool { return partOf(k, "capture").State == "running" })
	// вопрос — по контракту с «выпусками»: releases.plan v1 на .releases с id
	if q := s.relay.firstAsk(); q["v"] != float64(1) || q["to"] != ".releases" || q["id"] == "" || q["id"] == nil {
		t.Fatalf("вопрос о плане %v", q)
	}
	p := partOf(k, "capture")
	if p.Version != "1.3.2" || p.Pid == 0 {
		t.Fatalf("state %+v", p)
	}
	if !exists(filepath.Join(s.home, "parts", "capture", "data")) || !exists(filepath.Join(s.home, "parts", "capture", "1.3.2", "release.sha256")) {
		t.Fatal("нет папки версии или data/")
	}
	waitFor(t, "вывод в журнале", func() bool { return journalHas(s.home, `"line":"app 1.3.2 start`) })
	var saved plan
	b, _ := os.ReadFile(planPath(s.home))
	if json.Unmarshal(b, &saved) != nil || saved.Rev != 1 || len(saved.Parts) != 1 || saved.Parts[0].Version != "1.3.2" {
		t.Fatalf("plan.json — не ответ «выпусков»: %s", b)
	}
}

// Хэш не сошёлся: download_failed в keeper.state, прежняя версия работает.
func TestEtBadHashKeepsOld(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	bad := s.links.part("capture", "1.4.0", appFiles(""), on)
	bad["sha256"] = strings.Repeat("0", 64)
	s.relay.push(planMsg(2, bad))
	waitFor(t, "download_failed", func() bool { return strings.Contains(partOf(k, "capture").Error, "download_failed") })
	p := partOf(k, "capture")
	if p.State != "running" || p.Pid != pid || p.Version != "1.3.2" {
		t.Fatalf("прежняя версия тронута: %+v", p)
	}
	if exists(versionDir(s.home, "capture", "1.4.0")) {
		t.Fatal("папка битой версии осталась")
	}
	// выкладка не доехала — это видно и в журнале флота
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.4.0 — download_failed") })
	// app.json новой версии с чужим полем — версия негодна до остановки прежней (ревью архитектора 1 нояб.)
	app := appFiles("")
	app["app.json"] = `{"run":["x"],"user":"admin"}`
	s.relay.push(planMsg(3, s.links.part("capture", "1.5.0", app, on)))
	waitFor(t, "contract_mismatch", func() bool { return strings.Contains(partOf(k, "capture").Error, "contract_mismatch") })
	if p := partOf(k, "capture"); p.State != "running" || p.Pid != pid || p.Version != "1.3.2" {
		t.Fatalf("прежняя версия остановлена ради негодной: %+v", p)
	}
	waitFor(t, "part.failed 1.5.0", func() bool { return s.relay.ledgerHas("part.failed capture 1.5.0 — contract_mismatch") })
}

// Смена версии без наложения: новая стартует после выхода старой; part.updated; на диске — новая и предыдущая
// (план заморозки: «убрать версии, кроме текущей и предыдущей»).
func TestEtVersionSwitchNoOverlap(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	os.MkdirAll(versionDir(s.home, "capture", "0.9.0"), 0o700) // версия позапрошлой выкладки
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "1.4.0 running", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.4.0" })
	waitFor(t, "part.updated", func() bool { return s.relay.ledgerHas("part.updated capture 1.3.2 → 1.4.0") })
	// новый план исполнен целиком: keeper.state и plan.json — rev 2 (план заморозки: «хранить на диске»)
	var saved plan
	b0, _ := os.ReadFile(planPath(s.home))
	if json.Unmarshal(b0, &saved) != nil || saved.Rev != 2 || k.state().Rev != 2 {
		t.Fatalf("rev после кадра плана: plan.json %d, keeper.state %d", saved.Rev, k.state().Rev)
	}
	// старая вышла сама после закрытого ввода («bye») раньше, чем стартовала новая
	waitFor(t, "строка старта 1.4.0", func() bool { return journalHas(s.home, `"line":"app 1.4.0 start`) })
	b := readJournal(s.home)
	bye, start := strings.Index(b, `"line":"bye"`), strings.Index(b, `"line":"app 1.4.0 start`)
	if bye < 0 || start < 0 || bye > start {
		t.Fatalf("наложение версий: bye=%d start=%d", bye, start)
	}
	if !exists(versionDir(s.home, "capture", "1.3.2")) {
		t.Fatal("предыдущая версия убрана — отката без скачивания не будет")
	}
	waitFor(t, "позапрошлая версия убрана", func() bool { return !exists(versionDir(s.home, "capture", "0.9.0")) })
	es, _ := os.ReadDir(partDir(s.home, "capture"))
	var got []string
	for _, e := range es {
		got = append(got, e.Name())
	}
	if strings.Join(got, " ") != "1.3.2 1.4.0 data" {
		t.Fatalf("папки части: %v", got)
	}
}

// Не выходит по закрытию ввода: stopping держится до предела остановки; force — держатель убивает дерево: и останавливаемую (мимо
// очереди), и работающую (план заморозки, «Чего не делаем»: «остановка ждёт выхода, force убивает»).
func TestEtStubbornForce(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("stubborn"), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	off := s.links.part("capture", "1.3.2", appFiles("stubborn"), map[string]any{"on": false})
	s.relay.push(planMsg(2, off))
	waitFor(t, "stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	time.Sleep(time.Second)
	if partOf(k, "capture").State != "stopping" {
		t.Fatal("stopping держится до предела")
	}
	off["force"] = true
	s.relay.push(planMsg(3, off))
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	// force по работающей части — сразу, без ожидания закрытого ввода
	s.relay.push(planMsg(4, s.links.part("capture", "1.3.2", appFiles("stubborn"), on)))
	waitFor(t, "running снова", func() bool { return partOf(k, "capture").State == "running" })
	s.relay.push(planMsg(5, off))
	waitFor(t, "stopped силой", func() bool { return partOf(k, "capture").State == "stopped" })
	waitFor(t, "два выхода силой", func() bool {
		return strings.Count(readJournal(s.home), `"ev":"part_exit","version":"1.3.2","why":"сигнал SIGKILL`) == 2
	})
}

// 3123 · Часть не вышла за предел остановки после «закрой ввод» — строка stop_late с причиной, держатель убивает
// дерево, часть stopped; смена версии идёт дальше без рук (слово пользователя 2 нояб.: «у всех операций должен быть
// лимит и поддержка graceful shutdown»; устав: «не успела — жёсткий выход, это ожидаемая ветка»; факт — Host 1.1.56
// на 4 машинах прода висел в stopping, снят руками).
func TestEtStopLimitKills(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("stubborn"), on)))
	k := s.startWith(func(k *Keeper) { k.limit = 1500 * time.Millisecond })
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "1.3.2 stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	time.Sleep(700 * time.Millisecond)
	if partOf(k, "capture").State != "stopping" {
		t.Fatal("до предела часть ещё останавливается штатно")
	}
	waitFor(t, "1.4.0 running после предела", func() bool {
		p := partOf(k, "capture")
		return p.State == "running" && p.Version == "1.4.0"
	})
	if !journalHas(s.home, `"part":"capture"`) || !journalHas(s.home, `"kind":"stop","ev":"stop_late","why":"capture 1.3.2 не вышла за 1.5s после «закрой ввод» — держатель убивает дерево"`) || !journalHas(s.home, `"ev":"part_exit","version":"1.3.2","why":"сигнал SIGKILL`) {
		t.Fatal("нет строки stop_late или выхода силой\n" + readJournal(s.home))
	}
	if journalHas(s.home, `"ev":"part_failed"`) {
		t.Fatal("выход силой после предела — не падение части")
	}
}

// 3145 · setup версии не завершился за предел — убит, setup_failed с причиной, прежняя версия работает (слово
// пользователя 2 нояб.: «у всех операций должен быть лимит и поддержка graceful shutdown»).
func TestEtSetupLimit(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.startWith(func(k *Keeper) { k.limit = 1500 * time.Millisecond })
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	self, _ := os.Executable()
	app := appFiles("")
	b, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "hangsetup"}})
	app["app.json"] = string(b)
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", app, on)))
	waitFor(t, "setup_failed за предел", func() bool {
		return strings.Contains(partOf(k, "capture").Error, "setup_failed: не завершился за 1.5s")
	})
	p := partOf(k, "capture")
	if p.State != "running" || p.Version != "1.3.2" || p.Pid != pid {
		t.Fatalf("прежняя версия не работает: %+v", p)
	}
	if exists(stampPath(versionDir(s.home, "capture", "1.4.0"))) {
		t.Fatal("версия с зависшим setup отмечена готовой")
	}
}

// 3146 · новый файл keeper не ответил на version за предел — убит, keeper failed check_failed, keeper не выходит.
func TestEtSelfCheckLimit(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION_HANG", "1")
	kp := s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, kp))
	k := s.startWith(func(k *Keeper) { k.limit = 1500 * time.Millisecond })
	waitFor(t, "check_failed за предел", func() bool {
		return strings.Contains(partOf(k, "keeper").Error, "check_failed: новый файл не ответил за 1.5s")
	})
	select {
	case <-k.Done():
		t.Fatal("keeper остановился после check_failed")
	default:
	}
}

// silentHolder — держатель, который принимает соединение и молчит.
func silentHolder(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { c.Close() })
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

// deafHolder — держатель, который отвечает на ключ и не исполняет ни «закрой ввод», ни «убей».
func deafHolder(t *testing.T, pid int) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { c.Close() })
			go func() {
				readFrame(c)
				b, _ := json.Marshal(map[string]any{"pid": pid, "buffered": 0})
				writeFrame(c, frHello, b)
				for {
					if _, _, err := readFrame(c); err != nil {
						return
					}
				}
			}()
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

// 3147 · держатель принял соединение и молчит — при старте keeper подключение не висит: за 5 с файл держателя убран
// с причиной, keeper исполняет план дальше (слово пользователя 2 нояб.: «у всех операций должен быть лимит»).
func TestEtHolderSilentAdopt(t *testing.T) {
	s := newStand(t)
	os.MkdirAll(procsDir(s.home), 0o700)
	writeHoldFile(s.home, holdFile{ID: "capture", Owner: "keeper", Pid: os.Getpid(), Port: silentHolder(t), Key: "k", Tag: "1.3.2"})
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	start := time.Now()
	k := s.start()
	waitFor(t, "часть поднята по плану", func() bool { return partOf(k, "capture").State == "running" })
	if d := time.Since(start); d > 15*time.Second {
		t.Fatalf("старт ждал молчащего держателя %v", d)
	}
	if !journalHas(s.home, `держатель не отвечает — файл убран: держатель не ответил за 5s`) {
		t.Fatal("нет строки adopt с причиной")
	}
}

// 3148 · часть не вышла и после «убей» за предел — строка stop_late, часть failed, новая версия не запущена (две
// версии разом нельзя); правка плана решает (слово пользователя 2 нояб.: «у всех операций должен быть лимит»).
func TestEtKillWaitLimit(t *testing.T) {
	s := newStand(t)
	os.MkdirAll(procsDir(s.home), 0o700)
	// процесс части — отдельный: уборка стенда убивает держателей по pid из их файлов
	self, _ := os.Executable()
	child := exec.Command(self, "app", "deaf")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { child.Process.Kill(); child.Wait() })
	writeHoldFile(s.home, holdFile{ID: "capture", Owner: "keeper", Pid: child.Process.Pid, Port: deafHolder(t, child.Process.Pid), Key: "k", Tag: "1.3.2"})
	p1 := plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on))
	b, _ := json.Marshal(p1)
	os.WriteFile(planPath(s.home), b, 0o600)
	s.relay.setPlan(p1)
	k := s.startWith(func(k *Keeper) { k.limit = 700 * time.Millisecond })
	waitFor(t, "adopt", func() bool { return partOf(k, "capture").State == "running" })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "failed после «убей»", func() bool { return partOf(k, "capture").State == "failed" })
	if !journalHas(s.home, `не вышла и за 700ms после «убей»`) || journalHas(s.home, `"ev":"part_start","version":"1.4.0"`) {
		t.Fatal("нет stop_late после «убей» или новая версия запущена рядом с прежней")
	}
}

// 3157 · Новая версия отклонена до остановки прежней (404, setup упал, чужой хэш) — прежняя работает, ошибка словом
// в keeper.state, part.failed в журнал флота; другие части плана исполняются (чьё: код — «версия годна, когда стоит
// и её app.json разобран: только тогда прежняя останавливается»).
func TestEtRejectedKeepsOld(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	pid := partOf(k, "capture").Pid
	self, _ := os.Executable()
	missing := s.links.part("capture", "1.4.0", appFiles(""), on)
	missing["url"] = missing["url"].(string) + "-нет"
	setup := appFiles("")
	sb, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "badsetup"}})
	setup["app.json"] = string(sb)
	foreign := s.links.part("capture", "1.4.2", appFiles(""), on)
	foreign["sha256"] = strings.Repeat("0", 64)
	for i, c := range []struct {
		p    map[string]any
		word string
	}{{missing, "download_failed"}, {s.links.part("capture", "1.4.1", setup, on), "setup_failed"}, {foreign, "download_failed"}} {
		probe := s.links.part("probe", fmt.Sprintf("1.0.%d", i), appFiles(""), on)
		s.relay.push(planMsg(2+i, c.p, probe))
		waitFor(t, c.word+" у работающей", func() bool {
			return strings.Contains(partOf(k, "capture").Error, c.word) && partOf(k, "probe").Version == probe["version"]
		})
		if p := partOf(k, "capture"); p.State != "running" || p.Version != "1.3.2" || p.Pid != pid {
			t.Fatalf("прежняя версия не работает: %+v", p)
		}
		waitFor(t, "part.failed "+c.word, func() bool {
			return s.relay.ledgerHas("part.failed capture " + c.p["version"].(string) + " — " + c.word)
		})
	}
	if exists(versionDir(s.home, "capture", "1.4.1")) {
		t.Fatal("папка версии с упавшим setup осталась")
	}
}

// 3158 · Новая версия не запустилась под держателем — прежняя уже остановлена, часть failed «запуск: …», part.failed;
// перезапуска нет; откат записи снимает failed (чьё: код; устав — «дальше решает агент»).
func TestEtStartFailsWithOld(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", files{"app.json": `{"run":["нет-такой-программы-sb"]}`}, on)))
	waitFor(t, "failed запуск", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.HasPrefix(p.Error, "запуск: ")
	})
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.4.0 — запуск: ") })
	if !journalHas(s.home, `"line":"bye"`) {
		t.Fatal("прежняя версия не остановлена штатно до запуска новой")
	}
	time.Sleep(500 * time.Millisecond)
	if partOf(k, "capture").Restarts != 0 {
		t.Fatal("после failed — перезапуск")
	}
	s.relay.push(planMsg(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
	waitFor(t, "откат снимает failed", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.3.2" })
}

// 3159 · Откат на прежнюю версию — с диска: без скачивания и без строки installed; part_updated 1.4.0 → 1.3.2
// (чьё: код — папки версий «кроме текущей и предыдущей»; готовая версия — по метке).
func TestEtRollbackFromDisk(t *testing.T) {
	s := newStand(t)
	v1 := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.relay.setPlan(plan1(1, v1))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "1.4.0 running", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.4.0" })
	s.relay.push(planMsg(3, v1))
	waitFor(t, "1.3.2 снова", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.3.2" })
	j := readJournal(s.home)
	if linesWith(j, `"part":"capture"`, `"ev":"installed","version":"1.3.2"`) != 1 || linesWith(j, `"part":"capture"`, `"ev":"part_updated","from":"1.4.0","to":"1.3.2"`) != 1 {
		t.Fatal("откат не с диска или нет part_updated 1.4.0 → 1.3.2")
	}
	waitFor(t, "part.updated в журнал флота", func() bool { return s.relay.ledgerHas("part.updated capture 1.4.0 → 1.3.2") })
}

// 3160 · Тот же план повторно (переподключение) — ни строки plan, ни остановки, pid прежний (чьё: код — «та же rev»).
func TestEtSamePlanAgain(t *testing.T) {
	s := newStand(t)
	p5 := plan1(5, s.links.part("capture", "1.3.2", appFiles(""), on))
	s.relay.setPlan(p5)
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	pid := partOf(k, "capture").Pid
	s.relay.push(planMsg(5, s.links.part("capture", "1.3.2", appFiles(""), on)))
	time.Sleep(700 * time.Millisecond)
	if strings.Count(readJournal(s.home), `"ev":"plan","rev":5`) != 1 || partOf(k, "capture").Pid != pid {
		t.Fatal("тот же план исполнен заново")
	}
}

// 3161 · В новом плане запись части не менялась — часть не трогается, меняется только другая (устав: «обновление Host —
// по плану, сессии не останавливает»; чьё: код — «та же версия с тем же окружением — делать нечего»).
func TestEtUnchangedEntryUntouched(t *testing.T) {
	s := newStand(t)
	host := s.links.part("host", "1.1.0", appFiles(""), on)
	s.relay.setPlan(plan1(5, host, s.links.part("probe", "1.0.0", appFiles(""), on)))
	k := s.start()
	waitFor(t, "обе running", func() bool { return partOf(k, "host").State == "running" && partOf(k, "probe").State == "running" })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	pid := partOf(k, "host").Pid
	s.relay.push(planMsg(6, host, s.links.part("probe", "1.0.1", appFiles(""), on)))
	waitFor(t, "probe 1.0.1", func() bool { p := partOf(k, "probe"); return p.State == "running" && p.Version == "1.0.1" })
	if partOf(k, "host").Pid != pid || linesWith(readJournal(s.home), `"part":"host"`, `"ev":"part_start"`) != 1 {
		t.Fatal("host тронут планом, где его запись не менялась")
	}
}

// 3162 · Скачивание не уложилось в предел — download_failed с причиной, прежняя работает, part.failed (слово
// пользователя 2 нояб.: «у всех операций должен быть лимит»; предел скачивания — у клиента HTTP keeper).
func TestEtDownloadLimit(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	t.Cleanup(slow.Close)
	saved := httpClient
	httpClient = &http.Client{Timeout: time.Second}
	t.Cleanup(func() { httpClient = saved })
	p := s.links.part("capture", "1.4.0", appFiles(""), on)
	p["url"] = slow.URL + "/capture/1.4.0.tgz"
	s.relay.push(planMsg(2, p))
	waitFor(t, "download_failed за предел", func() bool {
		e := partOf(k, "capture").Error
		return strings.Contains(e, "download_failed") && strings.Contains(e, "Timeout")
	})
	if p := partOf(k, "capture"); p.State != "running" || p.Version != "1.3.2" {
		t.Fatalf("прежняя не работает: %+v", p)
	}
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.4.0 — download_failed") })
}

// 3163 · keeper не был на связи, пока план менялся: после переподключения — план с новой rev, часть на новой версии
// (чьё: код — «при каждом подключении: вопрос о плане»).
func TestEtReconnectNewPlan(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	s.relay.setPlan(plan1(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	s.relay.drop()
	waitFor(t, "1.4.0 после переподключения", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.4.0" })
	if !journalHas(s.home, `"ev":"plan","rev":2`) {
		t.Fatal("нет строки plan rev 2")
	}
}

// 3164 · Связь оборвалась, пока вопрос о плане ждал ответа — keeper переподключается и спрашивает снова; части не тронуты.
func TestEtDropWhileAsking(t *testing.T) {
	s := newStand(t)
	s.relay.setSilent(1)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "первый вопрос", func() bool { return s.relay.planAsks() == 1 })
	s.relay.drop()
	waitFor(t, "план со второго вопроса", func() bool { return partOf(k, "capture").State == "running" })
	if s.relay.planAsks() < 2 {
		t.Fatalf("вопросов %d", s.relay.planAsks())
	}
}

// 3165 · Остановка keeper, пока вопрос о плане ждёт ответа — выход сразу, keeper_exit последней строкой (устав:
// штатная остановка; чьё: код — остановка прерывает ожидание).
func TestEtStopWhileAsking(t *testing.T) {
	s := newStand(t)
	s.relay.setSilent(5)
	k := s.start()
	waitFor(t, "вопрос в пути", func() bool { return s.relay.planAsks() == 1 })
	start := time.Now()
	k.Stop()
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("остановка ждала ответ на вопрос %v", d)
	}
	j := strings.TrimSpace(readJournal(s.home))
	if !strings.Contains(j[strings.LastIndex(j, "\n")+1:], `"ev":"keeper_exit"`) {
		t.Fatal("keeper_exit не последней строкой")
	}
}

// 3166 · План меняет и часть, и keeper — keeper последним: новая версия части running раньше подмены себя (чьё: код).
func TestEtSelfUpdateLast(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil), s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	select {
	case <-k.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	j := readJournal(s.home)
	if a, b := strings.Index(j, `"ev":"part_start","version":"1.3.2"`), strings.Index(j, `"ev":"self_update"`); a < 0 || b < 0 || a > b {
		t.Fatalf("порядок: part_start capture %d, self_update %d", a, b)
	}
}

// 3167 · Запись keeper с работающей версией — без подмены себя и без строк о ней (чьё: код).
func TestEtKeeperSameVersionNoUpdate(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("keeper", keeperVersion, files{"x": "y"}, nil), s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "capture running", func() bool { return partOf(k, "capture").State == "running" })
	time.Sleep(500 * time.Millisecond)
	select {
	case <-k.Done():
		t.Fatal("keeper вышел")
	default:
	}
	if journalHas(s.home, `"ev":"self_update"`) || journalHas(s.home, `"part":"keeper","version":"`+keeperVersion+`"`) && partOf(k, "keeper").State == "failed" {
		t.Fatal("подмена себя на ту же версию")
	}
}

// 3168 · Архив keeper не сошёлся по хэшу — keeper failed download_failed, part.failed, keeper работает дальше.
func TestEtSelfDownloadFailed(t *testing.T) {
	s := newStand(t)
	kp := s.links.part("keeper", "9.9.9", files{"x": "y"}, nil)
	kp["sha256"] = strings.Repeat("0", 64)
	s.relay.setPlan(plan1(1, kp, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "keeper failed", func() bool {
		p := partOf(k, "keeper")
		return p.State == "failed" && strings.Contains(p.Error, "download_failed")
	})
	waitFor(t, "part.failed keeper", func() bool { return s.relay.ledgerHas("part.failed keeper 9.9.9 — download_failed") })
	if partOf(k, "capture").State != "running" {
		t.Fatal("остальной план не исполнен")
	}
	select {
	case <-k.Done():
		t.Fatal("keeper вышел")
	default:
	}
}

// 3169 · Сбой подмены и следующий план с той же записью keeper — подмена пробуется снова (чьё: код — решение
// архитектора 2 нояб.: повтор с диска дешёвый, каждый сбой в журнале флота).
func TestEtSelfFailRepeatsOnPlan(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "1.0.0")
	kp := s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, kp))
	k := s.start()
	waitFor(t, "check_failed", func() bool { return strings.Contains(partOf(k, "keeper").Error, "check_failed") })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	s.relay.push(planMsg(2, kp, s.links.part("capture", "1.3.2", appFiles(""), on)))
	waitFor(t, "второй сбой", func() bool { return s.relay.ledgerCount("part.failed keeper 9.9.9 — check_failed") == 2 })
}

// 3171 · Битый plan.json — держатели частей сняты как ничьи, части подняты по плану «выпусков» заново (чьё: код).
func TestEtBrokenPlanOrphans(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	k.Stop()
	os.WriteFile(planPath(s.home), []byte("{битый"), 0o600)
	k2 := s.start()
	waitFor(t, "часть поднята заново", func() bool { p := partOf(k2, "capture"); return p.State == "running" && p.Pid != pid })
	if !journalHas(s.home, `"ev":"orphan_kill","id":"capture"`) {
		t.Fatal("держатель части не снят как ничей")
	}
}

// 3172 · keeper.json не прочитан — старт отказан, держатели частей не тронуты (чьё: код).
func TestEtBadConfHoldersAlive(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	k.Stop()
	os.WriteFile(confPath(s.home), []byte("{битый"), 0o600)
	code, _, _ := runKeeper(t, s.home, "", "run")
	if code != 1 || !alive(pid) {
		t.Fatalf("код %d, часть жива %v", code, alive(pid))
	}
}

// linesWith — сколько строк журнала содержат все части: поле part журнал ставит в начало строки.
func linesWith(j string, subs ...string) int {
	n := 0
	for _, l := range strings.Split(j, "\n") {
		ok := true
		for _, x := range subs {
			ok = ok && strings.Contains(l, x)
		}
		if ok {
			n++
		}
	}
	return n
}

// Одно падение — один перезапуск, с диска: ссылка из плана живёт час; второе — failed и part.failed; та же запись
// плана failed не трогает (устав, закрытый список: «умерла — один перезапуск, второе падение — failed, дальше решает
// агент (set on:false → on:true)»).
func TestEtOneRestartThenFailed(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	s.links.expire()
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	if !journalHas(s.home, `"kind":"stop","ev":"part_exit","why":"capture 1.3.2 вышла сама`) {
		t.Fatal("нет строки о падении")
	}
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.3.2 — второе падение") })
	// та же запись части с новой rev — keeper failed не трогает: решает тот, кто правит план
	same := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.relay.push(planMsg(2, same))
	time.Sleep(700 * time.Millisecond)
	if partOf(k, "capture").State != "failed" {
		t.Fatal("failed поднят без правки плана")
	}
	// on: false, затем on: true — чистый перезапуск
	off := s.links.part("capture", "1.3.2", appFiles(""), map[string]any{"on": false})
	s.relay.push(planMsg(3, off))
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	s.relay.push(planMsg(4, same))
	waitFor(t, "running снова", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 0 })
}

// Перезагрузка без связи: файл держателя, умершего с машиной, убран; keeper исполняет сохранённый план
// (план заморозки: «хранить на диске и исполнять без связи»; устав, система ловит — строки с причиной).
func TestEtSavedPlanWithoutRelay(t *testing.T) {
	s := newStand(t)
	pl := plan1(7, s.links.part("capture", "1.3.2", appFiles(""), on))
	b, _ := json.Marshal(pl)
	os.WriteFile(planPath(s.home), b, 0o600)
	writeConf(s.home, map[string]any{}) // relay нет
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	writeHoldFile(s.home, holdFile{ID: "capture", Owner: "keeper", Port: port, Key: "dead", Tag: "1.3.2"})
	k := s.start()
	waitFor(t, "running без связи", func() bool { return partOf(k, "capture").State == "running" })
	for _, want := range []string{`"kind":"stop","ev":"relay","why":"в keeper.json нет адреса relay`,
		`"ev":"adopt","id":"capture","why":"держатель не отвечает — файл убран`, `"ev":"plan","rev":7`, `"ev":"part_start","version":"1.3.2","pid":`} {
		if !journalHas(s.home, want) {
			t.Fatalf("нет строки %s", want)
		}
	}
}

// Перезапуск keeper не трогает процессы: новый keeper подключается к держателю, pid тот же, вывод без keeper дочитан
// (устав, закрытый список: «keeper умер или подменил себя — …держатели живут, keeper подключается к своим»).
func TestEtKeeperRestartAdopts(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("chatty"), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	k.Stop()
	time.Sleep(200 * time.Millisecond) // часть пишет без keeper — держатель копит
	k2 := s.start()
	waitFor(t, "подключился", func() bool { p := partOf(k2, "capture"); return p.State == "running" && p.Pid == pid })
	if partOf(k2, "capture").Version != "1.3.2" {
		t.Fatal("версия держателя потеряна")
	}
	r := journalLine(s.home, fmt.Sprintf(`"ev":"adopt","id":"capture","pid":%d`, pid))
	if r == nil || r["buffered"] == float64(0) || r["buffered"] == nil {
		t.Fatalf("строка adopt %v — накопленное без keeper не дочитано", r)
	}
}

// Выход без keeper — одно падение: держатель хранит код выхода, новый keeper получает его и поднимает часть.
func TestEtExitWithoutKeeper(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	k.Stop()
	killPid(t, pid)
	time.Sleep(300 * time.Millisecond)
	k2 := s.start()
	waitFor(t, "один перезапуск", func() bool {
		p := partOf(k2, "capture")
		return p.State == "running" && p.Restarts == 1 && p.Pid != pid
	})
	if !journalHas(s.home, `"kind":"stop","ev":"part_exit","why":"capture 1.3.2 вышла сама: `) {
		t.Fatal("нет строки о падении")
	}
}

// keeper отвечает состояние сам, без Host.
func TestEtKeeperState(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	r := s.relay.ask(map[string]any{"type": "keeper.state", "to": ".keeper@win"})
	if r["ok"] != true {
		t.Fatalf("ответ %v", r)
	}
	res := r["result"].(map[string]any)
	if res["keeper"] != keeperVersion || res["rev"].(float64) != 3 || res["os"] == "" {
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

// Ничей держатель убит: часть не из плана — на старте kill.
func TestEtOrphanHolderKilled(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	f, err := spawnHolder(s.home, holdSpec{ID: "old", Owner: "keeper", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	s.relay.setPlan(plan1(1))
	s.start()
	waitFor(t, "ничей убит", func() bool { return !exists(holdPath(s.home, "old")) })
	waitFor(t, "процесс ничьего держателя умер", func() bool { return !alive(f.Pid) })
	if !journalHas(s.home, `"ev":"orphan_kill","id":"old"`) {
		t.Fatal("нет строки orphan_kill")
	}
}

// Держатели Host keeper не трогает: ни подключения, ни снятия (устав: «Процессы claude держит Host через свои держатели»).
func TestEtHostHoldersUntouched(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	f, err := spawnHolder(s.home, holdSpec{ID: "site@win", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "план rev 1", func() bool { return k.state().Rev == 1 })
	time.Sleep(700 * time.Millisecond)
	if !exists(holdPath(s.home, "site@win")) || !alive(f.Pid) {
		t.Fatal("держатель Host тронут")
	}
	if journalHas(s.home, `"ev":"adopt","id":"site@win"`) || journalHas(s.home, `"ev":"orphan_kill","id":"site@win"`) {
		t.Fatal("keeper взялся за держатель Host")
	}
}

// Новое окружение части в плане при той же версии — перезапуск с ним (ревью архитектора 1 нояб.).
func TestEtEnvChangeRestarts(t *testing.T) {
	s := newStand(t)
	part := s.links.part("capture", "1.3.2", appFiles("env"), on)
	s.relay.setPlan(plan1(1, part))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	withEnv := map[string]any{}
	for kk, v := range part {
		withEnv[kk] = v
	}
	withEnv["env"] = map[string]string{"SITE": "lab"}
	s.relay.push(planMsg(2, withEnv))
	waitFor(t, "перезапуск с новым окружением", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Pid != 0 && p.Pid != pid })
	waitFor(t, "часть видит новое окружение", func() bool { return journalHas(s.home, "SITE=lab") })
	s.relay.push(planMsg(3, withEnv))
	time.Sleep(500 * time.Millisecond)
	if p := partOf(k, "capture"); p.Restarts != 0 || p.State != "running" {
		t.Fatalf("тот же план с новой rev тронул часть: %+v", p)
	}
}

// Самообновление: последним шагом плана, где бы ни стояла запись keeper; новый файл ответил своей версией → подмена
// своего файла, part.updated и выход; держатели живут (план заморозки, «Подмена себя»: «По плану, последним шагом;
// держатели живут»).
func TestEtSelfUpdate(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	app := s.links.part("capture", "1.3.2", appFiles(""), on)
	kp := s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, kp, app))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	select {
	case <-k.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	b, _ := os.ReadFile(target)
	if len(b) != len(bin) {
		t.Fatal("файл keeper не подменён")
	}
	if ms, _ := filepath.Glob(target + "." + keeperVersion + ".*.old"); len(ms) != 1 {
		t.Fatalf("старый файл не переименован: %v", ms)
	}
	if f := readHoldFiles(s.home); len(f) != 1 || !alive(f[0].Pid) {
		t.Fatal("держатель приложения не пережил подмену keeper")
	}
	waitFor(t, "part.updated keeper", func() bool { return s.relay.ledgerHas("part.updated keeper " + keeperVersion + " → 9.9.9") })
}

// Новый файл keeper не тот: check_failed, keeper не выходит.
func TestEtSelfUpdateCheckFailed(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "1.0.0")
	kp := s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, kp))
	k := s.start()
	waitFor(t, "check_failed", func() bool { return strings.Contains(partOf(k, "keeper").Error, "check_failed") })
	select {
	case <-k.Done():
		t.Fatal("keeper остановился после check_failed")
	default:
	}
	if !journalHas(s.home, `"ev":"part_failed","why":"keeper 9.9.9: check_failed`) {
		t.Fatal("сбой подмены не в журнале машины")
	}
	// сбой подмены — как у любой части: и в журнале флота (чьё: код, install.go «как у любой части»)
	waitFor(t, "part.failed keeper", func() bool { return s.relay.ledgerHas("part.failed keeper 9.9.9 — check_failed") })
}

/* ===== держатель ===== */

// Держатель копит вывод без хозяина и отдаёт его хозяину; второй хозяин вытесняет первого; чужой ключ — bad_key
// (чьё: код — «Протокол держателя — заморожен», «Подключается к нему только хозяин, по ключу»; план заморозки,
// «Держатель»: «накопление без хозяина»).
func TestEtHolderBufferAndOwner(t *testing.T) {
	// байты кадра — образец замороженного протокола; тот же образец проверяет Host
	var gb bytes.Buffer
	writeFrame(&gb, frAuth, []byte("key"))
	if gb.String() != "a\x00\x00\x00\x03key" {
		t.Fatalf("кадр %q", gb.String())
	}
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "x", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	// хозяин — байтами замороженного протокола: 'a', длина big-endian, ключ; ответ — 'h' с JSON ровно {pid, buffered}
	raw, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port))
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 5, 5+len(f.Key))
	auth[0] = 'a'
	binary.BigEndian.PutUint32(auth[1:5], uint32(len(f.Key)))
	raw.Write(append(auth, f.Key...))
	var hdr [5]byte
	if _, err := io.ReadFull(raw, hdr[:]); err != nil || hdr[0] != 'h' {
		t.Fatalf("ответ на ключ %q %v", hdr[:], err)
	}
	body := make([]byte, binary.BigEndian.Uint32(hdr[1:5]))
	io.ReadFull(raw, body)
	var hello map[string]any
	json.Unmarshal(body, &hello)
	if len(hello) != 2 || hello["pid"] != float64(f.Pid) || hello["buffered"] == float64(0) || hello["buffered"] == nil {
		t.Fatalf("hello %s", body)
	}
	c1 := &heldConn{c: raw}
	var first strings.Builder
	firstDone := make(chan error, 1)
	go func() {
		x, err := c1.read(func(b []byte) { first.Write(b) })
		if x != nil {
			err = fmt.Errorf("прежнему хозяину отдан выход %+v", x)
		}
		firstDone <- err
	}()
	c2, hh, err := dialHolder(f)
	if err != nil || hh.Pid != f.Pid {
		t.Fatalf("второй хозяин: %+v %v", hh, err)
	}
	if err := <-firstDone; err == nil || !strings.Contains(first.String(), "app 1 start") {
		t.Fatalf("прежний хозяин не вытеснен или без накопленного: %v %q", err, first.String())
	}
	waitFor(t, "строка held_replaced", func() bool { return journalHas(home, `"ev":"held_replaced"`) })
	bad := f
	bad.Key = "nope"
	if _, _, err := dialHolder(bad); err == nil || !strings.Contains(err.Error(), "bad_key") {
		t.Fatalf("чужой ключ: %v", err)
	}
	// выход процесса — у второго хозяина
	c2.closeInput()
	if x, err := c2.read(func([]byte) {}); err != nil || x == nil {
		t.Fatalf("выход второму хозяину %v %v", x, err)
	}
}

// Умер держатель — умер процесс: ничьих процессов не бывает.
func TestEtHolderDiesChildDies(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "y", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf holdFile
	b, _ := os.ReadFile(holdPath(home, "y"))
	json.Unmarshal(b, &hf)
	killPid(t, hf.Holder)
	waitFor(t, "процесс умер с держателем", func() bool { return !alive(f.Pid) })
}

func readJournal(home string) string {
	ms, _ := filepath.Glob(filepath.Join(home, "journal", "keeper-*.jsonl"))
	var s strings.Builder
	for _, m := range ms {
		b, _ := os.ReadFile(m)
		s.Write(b)
	}
	return s.String()
}

// npm из app.json — npm-cli.js рядом с Node из keeper.json под тем же Node: на Windows npm — это npm.cmd,
// а у службы может не быть PATH (чьё: дизайн «npm — npm рядом с ним»).
func TestNpmNextToNode(t *testing.T) {
	d := t.TempDir()
	node := filepath.Join(d, exeName("node"))
	cli := filepath.Join(d, "node_modules", "npm", "bin", "npm-cli.js")
	os.MkdirAll(filepath.Dir(cli), 0o755)
	os.WriteFile(node, nil, 0o755)
	os.WriteFile(cli, nil, 0o644)
	k := &Keeper{node: node}
	got := k.command([]string{"npm", "ci", "--omit=dev"}, d)
	if strings.Join(got, "|") != strings.Join([]string{node, cli, "ci", "--omit=dev"}, "|") {
		t.Fatalf("команда %v", got)
	}
	if got := (&Keeper{}).command([]string{"npm", "ci"}, d); got[0] != "npm" {
		t.Fatalf("без node в keeper.json — npm как есть: %v", got)
	}
	// node — Node из keeper.json; путь, который есть в папке версии, — полный (чьё: код — keeper.go command)
	os.WriteFile(filepath.Join(d, "main.cjs"), nil, 0o644)
	if got := k.command([]string{"node", "main.cjs", "x"}, d); strings.Join(got, "|") != strings.Join([]string{node, filepath.Join(d, "main.cjs"), "x"}, "|") {
		t.Fatalf("команда node %v", got)
	}
}

// setup — в папке версии, а не во временной: npm на Windows связывает пакеты workspaces ссылками с полным путём,
// после переименования временной папки Host не находил свои пакеты (живой прогон 1 нояб., win: ERR_MODULE_NOT_FOUND).
func TestSetupInVersionDir(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	app := appFiles("")
	b, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "setup"}})
	app["app.json"] = string(b)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", app, on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	dir := versionDir(s.home, "capture", "1.3.2")
	got, _ := os.ReadFile(filepath.Join(dir, "setup-dir"))
	a, _ := os.Stat(string(got))
	d, _ := os.Stat(dir)
	if a == nil || d == nil || !os.SameFile(a, d) {
		t.Fatalf("setup шёл в %q, а версия в %q", got, dir)
	}
}

/* ===== заморозка 1.0.0: ветки, которые закрепил харденинг ===== */

// Кадр плана отклонён: не от .releases — bad_from; замороженный keeper не исполняет того, чего не знает: чужое поле
// части или v≠1 у кадра — contract_mismatch; план и части не тронуты (план заморозки, контракт «план машины v1»:
// «чужое поле или v≠1 — отказ»; эталон «План не от «выпусков» не исполняется»).
func TestEtPlanContractMismatch(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "план rev 1", func() bool { return k.state().Rev == 1 })
	foreign := planMsg(5, s.links.part("capture", "1.0.0", appFiles(""), on))
	foreign["from"] = "phone~x@y"
	s.relay.push(foreign)
	extra := s.links.part("capture", "1.0.0", appFiles(""), on)
	extra["args"] = []string{"--x"}
	s.relay.push(planMsg(2, extra))
	v2 := planMsg(3, s.links.part("capture", "1.0.0", appFiles(""), on))
	v2["v"] = 2
	s.relay.push(v2)
	waitFor(t, "три отказа", func() bool {
		j := readJournal(s.home)
		return strings.Count(j, `"word":"contract_mismatch"`) == 2 && strings.Count(j, `"word":"bad_from"`) == 1
	})
	time.Sleep(300 * time.Millisecond)
	if k.state().Rev != 1 || partOf(k, "capture").State != "" {
		t.Fatalf("отклонённый план исполнен: %+v", k.state())
	}
}

// План старше исполняемого не исполняется — строка refuse old_rev (чьё: код — keeper.go «меньшая — «выпуски»
// потеряли счёт: такой план не исполняется, строка в журнале»).
func TestEtPlanOldRev(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(5))
	k := s.start()
	waitFor(t, "rev 5", func() bool { return k.state().Rev == 5 })
	s.relay.push(planMsg(3, s.links.part("capture", "1.0.0", appFiles(""), on)))
	waitFor(t, "old_rev", func() bool { return journalHas(s.home, `"word":"old_rev"`) })
	if n := strings.Count(readJournal(s.home), `"word":"old_rev"`); n != 1 || k.state().Rev != 5 || partOf(k, "capture").State != "" {
		t.Fatalf("строк old_rev %d, rev %d", n, k.state().Rev)
	}
}

// Битый plan.json — строка stop с причиной; keeper живёт и берёт план у «выпусков».
func TestEtBrokenPlanFile(t *testing.T) {
	s := newStand(t)
	os.WriteFile(planPath(s.home), []byte("{битый"), 0o600)
	s.relay.setPlan(plan1(2, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	if r := journalLine(s.home, `"ev":"plan","why":"plan.json`); r == nil || r["kind"] != "stop" {
		t.Fatalf("строка о битом plan.json: %v", r)
	}
	waitFor(t, "план от «выпусков»", func() bool { return partOf(k, "capture").State == "running" })
}

// Старая версия упала, пока ставится новая: работает один экземпляр новой версии, перезапусков 0
// (ревью 1 нояб.: было два экземпляра).
func TestEtCrashDuringInstall(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	old := partOf(k, "capture").Pid
	self, _ := os.Executable()
	app := appFiles("")
	b, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "slowsetup"}})
	app["app.json"] = string(b)
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", app, on)))
	waitFor(t, "setup идёт", func() bool { return exists(filepath.Join(versionDir(s.home, "capture", "1.4.0"), "setup-started")) })
	killPid(t, old)
	waitFor(t, "1.4.0 running", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.4.0" })
	time.Sleep(time.Second) // выход старой версии разобран
	starts := strings.Count(readJournal(s.home), `"ev":"part_start","version":"1.4.0"`)
	if p := partOf(k, "capture"); starts != 1 || p.Restarts != 0 || p.State != "running" {
		t.Fatalf("стартов 1.4.0: %d, %+v", starts, p)
	}
}

// Упрямая часть останавливается — keeper ждёт её со всем остальным: упавшая другая часть ждёт в exited;
// force по первой пускает перезапуск второй (дизайн: план исполняется после выхода).
func TestEtStubbornHoldsRestartUntilForce(t *testing.T) {
	s := newStand(t)
	a := s.links.part("capture", "1.3.2", appFiles("stubborn"), on)
	b := s.links.part("probe", "1.0.0", appFiles(""), on)
	s.relay.setPlan(plan1(1, a, b))
	k := s.start()
	waitFor(t, "обе running", func() bool { return partOf(k, "capture").State == "running" && partOf(k, "probe").State == "running" })
	off := s.links.part("capture", "1.3.2", appFiles("stubborn"), map[string]any{"on": false})
	s.relay.push(planMsg(2, off, b))
	waitFor(t, "capture stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	killPid(t, partOf(k, "probe").Pid)
	waitFor(t, "probe exited", func() bool { return partOf(k, "probe").State == "exited" })
	off["force"] = true
	s.relay.push(planMsg(3, off, b))
	waitFor(t, "probe перезапущена", func() bool { p := partOf(k, "probe"); return p.State == "running" && p.Restarts == 1 })
	if st := partOf(k, "capture").State; st != "stopped" {
		t.Fatalf("capture %s", st)
	}
}

// Сбой установки части, которая ещё не работает: failed со словом и part.failed в журнале флота — хэш не сошёлся,
// в архиве не файл и не папка, app.json с чужим полем, setup упал (тогда папки версии нет) (план заморозки: находки
// «Сбой установки части не доходит до журнала флота», «архив со ссылкой → download_failed», «чужое поле в app.json —
// отказ этой части»; устав, система ловит); имя версии с путём — bad_plan, нет app.json — no_app_json (чьё: код —
// install.go validID, readApp).
func TestEtInstallFailedToLedger(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
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
	setup := appFiles("")
	sb, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "badsetup"}})
	setup["app.json"] = string(sb)
	noApp := s.links.part("radar", "1.0.0", files{"main.cjs": "x"}, on)
	badName := s.links.part("sonar", "1.0.0", appFiles(""), on)
	badName["version"] = "1.0.0/../x"
	s.relay.setPlan(plan1(1, bad, link, s.links.part("meter", "1.0.0", foreign, on), s.links.part("web", "1.0.0", setup, on), noApp, badName))
	k := s.start()
	waitFor(t, "sonar failed bad_plan", func() bool {
		p := partOf(k, "sonar")
		return p.State == "failed" && strings.HasPrefix(p.Error, "bad_plan")
	})
	for _, c := range []struct{ part, word string }{{"capture", "download_failed"}, {"probe", "download_failed"},
		{"meter", "contract_mismatch"}, {"web", "setup_failed"}, {"radar", "no_app_json"}} {
		waitFor(t, c.part+" failed "+c.word, func() bool { p := partOf(k, c.part); return p.State == "failed" && strings.Contains(p.Error, c.word) })
		waitFor(t, "part.failed "+c.part, func() bool { return s.relay.ledgerHas("part.failed " + c.part + " 1.0.0 — " + c.word) })
	}
	if !strings.Contains(partOf(k, "probe").Error, "только файлы и папки") || !strings.Contains(partOf(k, "web").Error, "npm ERR! нет пакета") {
		t.Fatalf("причины: %q · %q", partOf(k, "probe").Error, partOf(k, "web").Error)
	}
	if exists(versionDir(s.home, "web", "1.0.0")) {
		t.Fatal("папка версии с упавшим setup осталась")
	}
}

// Часть убрана из плана: остановлена штатно и снята из keeper.state, папки версий убраны, data/ осталась.
func TestEtPartRemoved(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	keep := filepath.Join(partDir(s.home, "capture"), "data", "keep")
	os.WriteFile(keep, []byte("1"), 0o600)
	s.relay.push(planMsg(2))
	waitFor(t, "снята", func() bool { return len(k.state().Parts) == 0 })
	// папки версий keeper убирает после того, как снял часть из keeper.state
	waitFor(t, "папка версии убрана", func() bool { return !exists(versionDir(s.home, "capture", "1.3.2")) })
	if !exists(keep) {
		t.Fatal("data/ убрана")
	}
	if !journalHas(s.home, `"line":"bye"`) {
		t.Fatal("часть не остановлена закрытием ввода")
	}
}

// Приложение получает от keeper окружение машины и окружение из плана.
func TestEtPartEnv(t *testing.T) {
	s := newStand(t)
	p := s.links.part("capture", "1.3.2", appFiles("env"), on)
	p["env"] = map[string]string{"SITE": "lab"}
	s.relay.setPlan(plan1(1, p))
	s.start()
	waitFor(t, "строка env", func() bool { return journalHas(s.home, `"line":"env `) })
	line, _ := journalLine(s.home, `"line":"env `)["line"].(string)
	self, _ := os.Executable()
	data := filepath.Join(partDir(s.home, "capture"), "data")
	for _, want := range []string{"SWITCHBOARD_MACHINE=win", "SWITCHBOARD_VERSION=1.3.2", "SWITCHBOARD_DATA=" + data,
		"SWITCHBOARD_HOLDER=" + self, "SWITCHBOARD_RELAY= ", "SWITCHBOARD_WORKERS={", "SITE=lab"} {
		if !strings.Contains(line, want) {
			t.Fatalf("нет %s в %q", want, line)
		}
	}
}

// Процесс не читает ввод: 256 КБ ввода и «убей» — процесс снят меньше чем за секунду, хозяин получил выход SIGKILL
// (план заморозки, находка «Убей»; опыт 1 нояб. на 0.5.6: от 8 КБ процесс жив через 8 с).
func TestEtHolderKillBehindInput(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "d", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app", "deaf"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	go func() {
		chunk := make([]byte, 32*1024)
		for i := 0; i < 8; i++ {
			if c.send(frInput, chunk) != nil {
				return
			}
		}
		c.kill()
	}()
	x, err := c.read(func([]byte) {})
	d := time.Since(start)
	if err != nil || x == nil || x.Signal == nil || *x.Signal != "SIGKILL" {
		t.Fatalf("выход %+v %v", x, err)
	}
	t.Logf("снят через %v", d)
	if d > time.Second {
		t.Fatalf("снят через %v", d)
	}
	waitFor(t, "процесс снят", func() bool { return !alive(f.Pid) })
}

// После подмены себя версии keeper на диске — новая и та, с которой ушли: прежний файл для отката лежит рядом
// (машины 1 нояб.: 6 версий, 77 МБ).
func TestEtSelfUpdateCleansVersions(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	for _, v := range []string{"0.0.1", keeperVersion} {
		os.MkdirAll(versionDir(s.home, "keeper", v), 0o700)
	}
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	select {
	case <-k.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	es, _ := os.ReadDir(partDir(s.home, "keeper"))
	var got []string
	for _, e := range es {
		got = append(got, e.Name())
	}
	if strings.Join(got, " ") != keeperVersion+" 9.9.9" {
		t.Fatalf("версии keeper: %v", got)
	}
}

// Остановка keeper, пока ставится новая версия: работающая живёт дальше с тем же pid, переход — у следующего keeper
// (ревью архитектора 1 нояб.: цикл доводил установку и гасил прежнюю версию).
func TestEtStopDuringInstallKeepsRunning(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	self, _ := os.Executable()
	app := appFiles("")
	b, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "slowsetup"}})
	app["app.json"] = string(b)
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", app, on)))
	waitFor(t, "setup идёт", func() bool { return exists(filepath.Join(versionDir(s.home, "capture", "1.4.0"), "setup-started")) })
	k.Stop()
	if !alive(pid) || journalHas(s.home, `"line":"bye"`) {
		t.Fatal("работающая версия остановлена вместе с keeper")
	}
	k2 := s.start()
	waitFor(t, "переход у следующего keeper", func() bool {
		p := partOf(k2, "capture")
		return p.State == "running" && p.Version == "1.4.0" && p.Restarts == 0
	})
	waitFor(t, "вывод новой версии в журнале", func() bool { return journalHas(s.home, `"line":"app 1.4.0 start`) })
	// следующий keeper подключился к прежней версии и довёл переход: прежняя вышла по закрытию ввода раньше старта
	// новой, архив второй раз не скачан, part_updated (чьё: код — keeper.go «переход — у следующего keeper»)
	j := readJournal(s.home)
	bye, start := strings.Index(j, `"line":"bye"`), strings.Index(j, `"line":"app 1.4.0 start`)
	installs := strings.Count(j, `"ev":"installed","version":"1.4.0"`)
	if !strings.Contains(j, fmt.Sprintf(`"ev":"adopt","id":"capture","pid":%d,"version":"1.3.2"`, pid)) || bye < 0 || start < bye ||
		installs != 1 || !strings.Contains(j, `"ev":"part_updated","from":"1.3.2","to":"1.4.0"`) {
		t.Fatalf("переход у следующего keeper: adopt, bye=%d start=%d, установок 1.4.0 %d", bye, start, installs)
	}
}

// Прежний файл keeper с тем же именем ещё занят (откат и новая выкладка, держатель прошлой эпохи) — подмена себя
// проходит (ревью 1 нояб.: Access is denied на Windows).
func TestEtSelfUpdateOldNameBusy(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	busy := target + "." + keeperVersion + ".old"
	os.WriteFile(busy, []byte("epoch 1"), 0o755)
	h, err := os.Open(busy)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	select {
	case <-k.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	if b, _ := os.ReadFile(target); len(b) != len(bin) {
		t.Fatal("файл keeper не подменён")
	}
}

// Штатная остановка: keeper дописал своё — keeper_exit последняя его строка в журнале, после Stop он не пишет;
// держатель и процесс части живут (находка пользователя 1 нояб.: CI на ubuntu — «journal: directory not empty» при
// уборке после Stop; устав: штатная остановка, «держатели живут»).
func TestEtStopLastLine(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("chatty"), on)))
	k := s.start()
	waitFor(t, "вывод идёт", func() bool { return journalHas(s.home, `"line":"tick 20"`) })
	pid := partOf(k, "capture").Pid
	k.Stop()
	if !alive(pid) || !exists(holdPath(s.home, "capture")) {
		t.Fatal("остановка keeper остановила часть")
	}
	time.Sleep(300 * time.Millisecond)
	var last map[string]any
	for _, l := range strings.Split(readJournal(s.home), "\n") {
		var r map[string]any
		if json.Unmarshal([]byte(l), &r) == nil && r["who"] == "keeper" {
			last = r
		}
	}
	if last["ev"] != "keeper_exit" {
		t.Fatalf("последняя строка keeper после остановки: %v", last)
	}
}

// Откат после неудачной подмены: план с работающей версией keeper снимает failed keeper из keeper.state.
func TestEtKeeperRollbackClearsFailed(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "0.0.0-wrong")
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)))
	k := s.start()
	waitFor(t, "check_failed", func() bool { return strings.Contains(partOf(k, "keeper").Error, "check_failed") })
	s.relay.push(planMsg(2, s.links.part("keeper", keeperVersion, files{"x": "x"}, nil)))
	waitFor(t, "failed снят", func() bool { return partOf(k, "keeper").State == "" })
}

// failed живёт до перезапуска keeper: новый keeper снова запускает часть и даёт ей один перезапуск
// (решение плана заморозки 1 нояб., чьё: код).
func TestEtFailedUntilKeeperRestart(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	k.Stop()
	k2 := s.start()
	waitFor(t, "снова running", func() bool { p := partOf(k2, "capture"); return p.State == "running" && p.Restarts == 0 })
}

// Обрыв связи с relay — keeper переподключается тем же hello и спрашивает план снова; тот же план части не трогает:
// pid тот же, строк plan нет (устав, закрытый список: «соединение… оборвалось — клиенты переподключаются»; чьё: код —
// relay.go «ключом машины и part: "keeper" в hello», keeper.go «Та же rev — переподключение»).
func TestEtRelayDropReasks(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	s.relay.drop()
	waitFor(t, "вопрос после переподключения", func() bool { return s.relay.planAsks() == 2 })
	time.Sleep(500 * time.Millisecond)
	hello, opens := s.relay.seen()
	if opens != 2 || hello["key"] != "host.win.ab12.sig" || hello["proto"] != float64(1) || hello["part"] != "keeper" {
		t.Fatalf("hello %v, входов %d", hello, opens)
	}
	if p := partOf(k, "capture"); p.Pid != pid || p.Restarts != 0 || p.State != "running" {
		t.Fatalf("переподключение тронуло часть: %+v", p)
	}
	j := readJournal(s.home)
	if strings.Count(j, `"ev":"plan","rev":1`) != 1 || strings.Contains(j, `"word":"old_rev"`) ||
		strings.Count(j, `"ev":"relay_open"`) != 2 || !strings.Contains(j, `"ev":"relay_closed"`) {
		t.Fatal("строки журнала о переподключении: нужны relay_open ×2, relay_closed, одна строка plan, без old_rev")
	}
}

// 5175 · «Выпуски» не ответили на вопрос о плане — строка журнала, соединение с relay своей машины не трогается;
// план приходит кадром releases.plan (источник: отчёт слепого архитектора 2 нояб., пункт 7 — лишняя коммуникация:
// повтор через переподключение relay; устав «система ловит, агент чинит» — без обходных путей).
func TestEtPlanNoAnswerNoReconnect(t *testing.T) {
	s := newStand(t)
	s.relay.setSilent(1)
	k := s.startWith(func(k *Keeper) { k.planWait = 500 * time.Millisecond })
	waitFor(t, "отказ timeout в журнале", func() bool { return journalHas(s.home, `"word":"timeout"`) })
	time.Sleep(time.Second)
	if _, opens := s.relay.seen(); opens != 1 || s.relay.planAsks() != 1 {
		t.Fatalf("hello %d, вопросов %d — keeper переподключался", opens, s.relay.planAsks())
	}
	s.relay.push(planMsg(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	waitFor(t, "план кадром", func() bool { return partOf(k, "capture").State == "running" })
}

/* ===== план тестов 1 нояб.: сценарии, у которых не было эталона ===== */

// После подмены себя прежние файлы keeper — с версией и pid и от установки — убраны на старте тем же шаблоном
// (план заморозки, находка «Подмена себя после отката»: «Уборка на старте находит их тем же шаблоном»).
func TestEtOldSelfCleanedOnStart(t *testing.T) {
	s := newStand(t)
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("cur"), 0o755)
	olds := []string{target + ".0.9.0.4242.old", target + ".prev.77.old"}
	for _, o := range olds {
		os.WriteFile(o, []byte("old"), 0o755)
	}
	s.relay.setPlan(plan1(1))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	waitFor(t, "план rev 1", func() bool { return k.state().Rev == 1 })
	for _, o := range olds {
		if exists(o) {
			t.Fatalf("прежний файл не убран: %s", o)
		}
	}
	if !exists(target) {
		t.Fatal("убран сам файл keeper")
	}
}

// Остановка keeper, пока упрямая прежняя версия выходит при смене версии: keeper не ждёт её и выходит с keeper_exit,
// новую версию не запускает — иначе две версии разом; прежняя живёт до force (чьё: код — «Остановка keeper прерывает
// ожидание»; устав: штатная остановка).
func TestEtStopDuringStubbornSwitch(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles("stubborn"), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles("stubborn"), on)))
	waitFor(t, "1.3.2 stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	start := time.Now()
	k.Stop()
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("остановка ждала упрямую часть %v", d)
	}
	if !journalHas(s.home, `"ev":"keeper_exit"`) || !alive(pid) || journalHas(s.home, `"ev":"part_start","version":"1.4.0"`) {
		t.Fatal("нет keeper_exit, прежняя версия снята или новая запущена")
	}
}

// «Выпуски» ответили на вопрос о плане отказом — строка refuse со словом, исполняется сохранённый план, соединение не
// рвётся: переспрашивает только молчание (устав: система ловит, «ошибки — словами»; чьё: код — askPlan).
func TestEtPlanReplyRefused(t *testing.T) {
	s := newStand(t)
	b, _ := json.Marshal(plan1(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
	os.WriteFile(planPath(s.home), b, 0o600)
	s.relay.setRefuse("cf_failed")
	k := s.start()
	waitFor(t, "строка отказа", func() bool { return journalHas(s.home, `"kind":"refuse","ev":"plan","word":"cf_failed"`) })
	waitFor(t, "сохранённый план", func() bool { return partOf(k, "capture").State == "running" })
	time.Sleep(700 * time.Millisecond)
	if k.state().Rev != 3 || s.relay.planAsks() != 1 {
		t.Fatalf("rev %d, вопросов %d", k.state().Rev, s.relay.planAsks())
	}
}

// Связь с relay: relay недоступен — keeper повторяет подключение, пока тот не поднимется; принял hello, но на ping
// молчит — соединение мёртвое: keeper закрывает его и подключается снова (устав, закрытый список: «соединение…
// оборвалось — клиенты переподключаются»; факт: сеть WSL теряет пакеты; чьё: код — «нет pong к следующему —
// соединение мёртвое»).
// Паузы между попытками — от первой вдвое до предела; после принятого hello — снова первая (чьё: код — relay.go
// «переподключение с паузой от 1 с, вдвое до 60 с»): 4 неудачи — паузы 50, 100, 200, 400 мс; после мёртвого
// соединения — 50 мс, а не 800.
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
		if n <= 4 {
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
	r := newRadio("ws"+strings.TrimPrefix(srv.URL, "http"), "host.win.ab12.sig")
	r.pingMs, r.pause0, r.pauseMax = 100*time.Millisecond, 50*time.Millisecond, time.Second
	var whys []string
	r.onState = func(open bool, why string) {
		if !open {
			mu.Lock()
			whys = append(whys, why)
			mu.Unlock()
		}
	}
	go r.run()
	t.Cleanup(r.close)
	waitFor(t, "второе подключение после молчания на ping", func() bool { mu.Lock(); defer mu.Unlock(); return hellos >= 2 })
	mu.Lock()
	defer mu.Unlock()
	dial := 0
	for _, w := range whys {
		if strings.HasPrefix(w, "dial: ") {
			dial++
		}
	}
	if dial != 4 {
		t.Fatalf("неудачных подключений %d: %q", dial, whys)
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

// Выключить — ввод закрыт, процесс вышел штатно, stopped; включить — снова с диска, без скачивания: ссылка из плана
// живёт час (план заморозки, «Жизнь части»: «остановка закрытием ввода»; «Установка версии»: «отметить папку»;
// чьё: код — «уже стоит из того же архива — без скачивания»).
func TestEtPartOffOn(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	off := s.links.part("capture", "1.3.2", appFiles(""), map[string]any{"on": false})
	back := s.links.part("capture", "1.3.2", appFiles(""), on)
	s.links.expire()
	s.relay.push(planMsg(2, off))
	waitFor(t, "stopped", func() bool { return partOf(k, "capture").State == "stopped" })
	if !journalHas(s.home, `"line":"bye"`) {
		t.Fatal("часть не остановлена закрытием ввода")
	}
	waitFor(t, "процесс вышел", func() bool { return !alive(pid) })
	s.relay.push(planMsg(3, back))
	waitFor(t, "running снова", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Pid != pid && p.Restarts == 0 })
	if n := strings.Count(readJournal(s.home), `"ev":"installed"`); n != 1 {
		t.Fatalf("установок %d — включение скачивало", n)
	}
}

// Команды run нет на машине — держатель не запустил её: часть failed с причиной «запуск: …» и part.failed в журнале
// флота (устав: система ловит; чьё: код).
func TestEtRunFailsToStart(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.0.0", files{"app.json": `{"run":["switchboard-no-such-program"]}`}, on)))
	k := s.start()
	waitFor(t, "failed", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.HasPrefix(p.Error, "запуск: ")
	})
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.0.0 — запуск: ") })
}

// Умер держатель части — связь с ним оборвалась без кадра выхода: это падение части, один перезапуск с причиной
// «связь с держателем оборвалась»; процесс ушёл вместе с держателем (устав, закрытый список: «умерла — один перезапуск»).
func TestEtHolderDiedPartRestarts(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	var hf holdFile
	b, _ := os.ReadFile(holdPath(s.home, "capture"))
	json.Unmarshal(b, &hf)
	killPid(t, hf.Holder)
	waitFor(t, "один перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 && p.Pid != pid })
	if !journalHas(s.home, `"ev":"part_exit","why":"capture 1.3.2 вышла сама: связь с держателем оборвалась`) {
		t.Fatal("нет строки о падении с причиной обрыва")
	}
	waitFor(t, "прежний процесс мёртв", func() bool { return !alive(pid) })
}

// Держатель запустил процесс: хозяину — порт, ключ и pid строкой о себе, то же — в файле procs/<id>.json; строки
// держателя — под тем, чей процесс он держит: часть машины — её именем, сессия Host — host и callsign (чьё: код —
// hold.go «пишет о себе … procs/<id>.json … и одной строкой то же — в свой stdout», «строки держателя — под тем, чей
// процесс он держит»).
func TestEtHolderJournalOwner(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	fp, err := spawnHolder(home, holdSpec{ID: "capture", Owner: "keeper", Tag: "1.3.2", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1.3.2"), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	fh, err := spawnHolder(home, holdSpec{ID: "site@win", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []holdFile{fp, fh} {
		var disk holdFile
		b, _ := os.ReadFile(holdPath(home, f.ID))
		json.Unmarshal(b, &disk)
		if f.Port == 0 || len(f.Key) != 64 || !alive(f.Pid) || disk.Port != f.Port || disk.Key != f.Key || disk.Pid != f.Pid || disk.Owner != f.Owner {
			t.Fatalf("о себе %+v, в файле %+v", f, disk)
		}
	}
	waitFor(t, "stderr части в журнале", func() bool { return journalHas(home, `"id":"capture","line":"app: stderr line"`) })
	if r := journalLine(home, `"id":"capture","line":"app: stderr line"`); r["part"] != "capture" || r["who"] != "holder" {
		t.Fatalf("строка держателя части %v", r)
	}
	if r := journalLine(home, `"ev":"hold","callsign":"site@win"`); r["part"] != "host" || r["who"] != "holder" {
		t.Fatalf("строка держателя сессии %v", r)
	}
}

// Держатель не запустил команду — хозяин получает отказ «держатель не запустился: …», в журнале — hold_failed с
// причиной, файла о держателе нет (устав: система ловит).
func TestEtHoldRefused(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	_, err := spawnHolder(home, holdSpec{ID: "z", Owner: "host", Env: os.Environ(), Cmd: []string{"switchboard-no-such-program"}})
	if err == nil || !strings.Contains(err.Error(), "держатель не запустился") {
		t.Fatalf("отказ хозяину: %v", err)
	}
	if r := journalLine(home, `"ev":"hold_failed"`); r == nil || r["kind"] != "stop" || r["why"] == "" || r["why"] == nil {
		t.Fatalf("строка hold_failed %v", r)
	}
	if exists(holdPath(home, "z")) {
		t.Fatal("файл держателя остался")
	}
}

// Ввод доходит до процесса по порядку, «закрой ввод» — после всего ввода из очереди; процесс вышел кодом 0
// (план заморозки, «Держатель»: «процесс, его ввод и вывод… Им же пользуется Host для сессий»; находка «Убей»:
// «„Закрой ввод“ встаёт в очередь за вводом»).
func TestEtHolderInputInOrder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "e", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app", "echo"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range []string{"a\n", "b\n", "c\n"} {
		c.send(frInput, []byte(l))
	}
	c.closeInput()
	var out strings.Builder
	x, err := c.read(func(b []byte) { out.Write(b) })
	if err != nil || x == nil || x.Code == nil || *x.Code != 0 {
		t.Fatalf("выход %+v %v", x, err)
	}
	if !strings.Contains(out.String(), "echo a\necho b\necho c\nbye\n") {
		t.Fatalf("вывод %q", out.String())
	}
}

// Хозяин ушёл — процесс живёт и пишет, держатель копит вывод; новый хозяин получает тот же pid и накопленное
// (план заморозки, «Держатель»: «накопление без хозяина»; устав, закрытый список: «держатели живут»).
func TestEtHolderOwnerLeftBuffers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "w", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app", "chatty"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	go c.read(func([]byte) {})
	time.Sleep(200 * time.Millisecond)
	c.Close()
	time.Sleep(300 * time.Millisecond)
	c2, hh, err := dialHolder(f)
	if err != nil || hh.Pid != f.Pid || hh.Buffered == 0 {
		t.Fatalf("новый хозяин: %+v %v", hh, err)
	}
	first := make(chan string, 1)
	go c2.read(func(b []byte) {
		select {
		case first <- string(b):
		default:
		}
	})
	select {
	case s := <-first:
		if !strings.Contains(s, "tick") {
			t.Fatalf("накопленное %q", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("накопленное не отдано")
	}
}

// Процесс вышел: держатель снимает его потомков (иначе они держали бы трубу вывода), отдаёт хозяину кадр выхода с
// кодом и последней строкой stderr после всего вывода; хозяин закрыл соединение — держатель убирает свой файл и выходит
// (чьё: код — hold.go «Процесс вышел, выход отдан хозяину и хозяин закрыл соединение — файл убран, держатель вышел»,
// «процесс вышел — его дети в задании тоже»).
func TestEtHolderExitKillsDescendants(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "p", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app", "parent"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf holdFile
	b, _ := os.ReadFile(holdPath(home, "p"))
	json.Unmarshal(b, &hf)
	c, _, err := dialHolder(f)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var out strings.Builder
	type res struct {
		x   *exitInfoJSON
		err error
	}
	done := make(chan res, 1)
	go func() {
		x, err := c.read(func(b []byte) { mu.Lock(); out.Write(b); mu.Unlock() })
		done <- res{x, err}
	}()
	child := 0
	waitFor(t, "потомок запущен", func() bool {
		mu.Lock()
		o := out.String()
		mu.Unlock()
		i := strings.Index(o, "child ")
		if i < 0 || !strings.Contains(o[i:], "\n") {
			return false
		}
		n, _ := fmt.Sscanf(o[i:], "child %d", &child)
		return n == 1
	})
	if !alive(child) {
		t.Fatal("потомок не жив")
	}
	c.closeInput()
	var r res
	select {
	case r = <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("выхода нет — потомок держит трубу")
	}
	if r.err != nil || r.x == nil || r.x.Code == nil || *r.x.Code != 0 || r.x.Stderr != "app: stderr line" {
		t.Fatalf("выход %+v %v", r.x, r.err)
	}
	mu.Lock()
	o := out.String()
	mu.Unlock()
	if !strings.Contains(o, "bye") {
		t.Fatalf("вывод до выхода %q", o)
	}
	waitFor(t, "потомок снят", func() bool { return !alive(child) })
	c.Close() // хозяин получил выход и закрыл соединение, как keeper и Host
	waitFor(t, "файл держателя убран", func() bool { return !exists(holdPath(home, "p")) })
	waitFor(t, "держатель вышел", func() bool { return !alive(hf.Holder) })
}

// Процесс вышел без хозяина — держатель жив, его файл на месте, выход хранится; хозяин пришёл и читает медленно —
// всё равно получает hello, накопленный вывод и кадр выхода убитого процесса; хозяин закрыл соединение — файл убран,
// держатель вышел (устав, закрытый список: «keeper умер или подменил себя — …держатели живут, keeper подключается к
// своим»; чьё: код — hold.go «Пока хозяина нет — копит вывод и код выхода»; находка цикла 2 нояб.: 2 из 50 прогонов на
// Windows — wsarecv «forcibly closed»: держатель выходил с открытым соединением, Windows сбрасывал его и выбрасывал
// непрочитанное хозяином).
func TestEtHolderKeepsExitForOwner(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := spawnHolder(home, holdSpec{ID: "slow", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf holdFile
	b, _ := os.ReadFile(holdPath(home, "slow"))
	json.Unmarshal(b, &hf)
	time.Sleep(500 * time.Millisecond) // строка о старте написана
	killPid(t, f.Pid)
	waitFor(t, "процесс убит", func() bool { return !alive(f.Pid) })
	time.Sleep(500 * time.Millisecond)
	if !exists(holdPath(home, "slow")) || !alive(hf.Holder) {
		t.Fatal("держатель не дождался хозяина")
	}
	raw, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port))
	if err != nil {
		t.Fatal(err)
	}
	if err := writeFrame(raw, frAuth, []byte(f.Key)); err != nil {
		t.Fatal(err)
	}
	// хозяин занят: держатель успевает отдать hello, накопленное и выход раньше, чем хозяин читает
	time.Sleep(time.Second)
	ty, body, err := readFrame(raw)
	if err != nil || ty != frHello {
		t.Fatalf("hello: %q %v", ty, err)
	}
	var hh holderHello
	json.Unmarshal(body, &hh)
	var out strings.Builder
	x, err := (&heldConn{c: raw}).read(func(b []byte) { out.Write(b) })
	killed := x != nil && ((x.Code != nil && *x.Code == 3) || (x.Signal != nil && *x.Signal == "SIGKILL"))
	if hh.Pid != f.Pid || err != nil || !killed || !strings.Contains(out.String(), "app 1 start") {
		t.Fatalf("hello %+v, выход %+v %v, вывод %q", hh, x, err, out.String())
	}
	// хозяин закрыл соединение — держатель убрал файл и вышел
	raw.Close()
	waitFor(t, "файл держателя убран", func() bool { return !exists(holdPath(home, "slow")) })
	waitFor(t, "держатель вышел", func() bool { return !alive(hf.Holder) })
}

/* ===== цикл тестов 1–2 нояб. (ночь): сценарии плана без эталона ===== */

// keeper.json не прочитан — keeper не стартует: код 1, «keeper: …» в stderr, строка stop keeper_start с причиной
// (устав: система ловит — «останавливает, отказывает, пишет в журнал с причиной»; код — чьё: код, main.go runConsole).
func TestEtBadConfStartRefused(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(confPath(home), []byte("{битый"), 0o600)
	code, _, stderr := runKeeper(t, home, "", "run")
	// консольный keeper повторяет журнал в stderr — слова причины отдельной строкой
	if code != 1 || !strings.Contains("\n"+stderr, "\nkeeper: ") {
		t.Fatalf("код %d, stderr %q", code, stderr)
	}
	if r := journalLine(home, `"ev":"keeper_start"`); r == nil || r["kind"] != "stop" || !strings.HasPrefix(fmt.Sprint(r["why"]), "keeper.json не прочитан: ") {
		t.Fatalf("строка keeper_start %v", r)
	}
}

// Штатная остановка закрывает связь с relay, и keeper больше не подключается (устав: «Каждая часть… останавливается
// штатно: …закрывает соединения… → выходит»). Слова причины закрытия relay пишет только в свой журнал — их не
// проверяем (цикл 2 нояб.: под нагрузкой кадр закрытия уходит не всегда; не находка — текст журнала relay).
func TestEtStopClosesLink(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "план rev 1", func() bool { return k.state().Rev == 1 })
	k.Stop()
	time.Sleep(1500 * time.Millisecond)
	if _, opens := s.relay.seen(); opens != 1 {
		t.Fatalf("после остановки keeper подключился снова: входов %d", opens)
	}
}

// 5084 · Установка: приглашение машины — первой строкой stdin; keeper принимает его POST gate.redeem и кладёт пропуск
// в machine.key; keeper.json — node из PATH полным путём, relay и Worker'ы из флагов, незнакомые поля целы; файл keeper —
// на постоянном месте (дизайн «Открытый флот»: «установка keeper принимает приглашение сама»; устав: секреты через stdin;
// чьё: код — main.go prepareConf, placeSelf, conf.go «Незнакомые поля сохраняются как есть»).
func TestEtInstallConf(t *testing.T) {
	r := newFakeRelay(t)
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	bin := t.TempDir()
	node := filepath.Join(bin, exeName("node"))
	os.WriteFile(node, []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", bin)
	writeConf(home, map[string]any{"site": "lab"})
	f, _ := parseInstall([]string{"--worker", "relay=https://relay.test/", "--worker", "gate=" + r.workerURL("gate"), "--worker", "releases=https://releases.test/", "--worker", "ledger=https://ledger.test/"})
	if err := prepareConf(f, bufio.NewReader(strings.NewReader("win1.INVITE\r\npassword\n"))); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "machine.key")); string(b) != "host.win.win1.SECRET\n" {
		t.Fatalf("machine.key %q", b)
	}
	m, _ := readConf(home)
	w := confMap(m, "workers")
	if m["node"] != node || m["relay"] != nil || w["relay"] != "https://relay.test/" || m["site"] != "lab" || w["releases"] != "https://releases.test/" || w["ledger"] != "https://ledger.test/" {
		t.Fatalf("keeper.json %v", m)
	}
	dst, err := placeSelf()
	self, _ := os.Executable()
	a, _ := os.Stat(self)
	b, _ := os.Stat(dst)
	if err != nil || dst != filepath.Join(home, exeName("keeper")) || b == nil || a.Size() != b.Size() {
		t.Fatalf("файл keeper %q: %v", dst, err)
	}
}

// 5084 · Погашенное приглашение, приглашение не машины, нет адреса gate или пустой stdin — отказ словами,
// machine.key не тронут (устав: система ловит — отказывает; чьё: код — main.go prepareConf).
func TestEtInstallKeyRefused(t *testing.T) {
	r := newFakeRelay(t)
	cases := []struct {
		in, gate, word string
	}{
		{"used.INVITE\n", r.workerURL("gate"), "bad_invite"},
		{"phn1.INVITE\n", r.workerURL("gate"), "не машины"},
		{"win1.INVITE\n", "", "нет адреса gate"},
		{"", r.workerURL("gate"), "stdin"},
	}
	for _, c := range cases {
		home := t.TempDir()
		t.Setenv("SWITCHBOARD_HOME", home)
		writeConf(home, map[string]any{"node": "/x/node"})
		os.WriteFile(filepath.Join(home, "machine.key"), []byte("host.win.old1.OLD\n"), 0o600)
		f := installFlags{workers: map[string]string{}}
		if c.gate != "" {
			f.workers["gate"] = c.gate
		}
		err := prepareConf(f, bufio.NewReader(strings.NewReader(c.in)))
		if b, _ := os.ReadFile(filepath.Join(home, "machine.key")); err == nil || !strings.Contains(err.Error(), c.word) || string(b) != "host.win.old1.OLD\n" {
			t.Fatalf("stdin %q: %v, machine.key %q", c.in, err, b)
		}
	}
}

// version — номер выпуска: собранный с -ldflags отвечает им, без него — версией из module.json; неизвестная команда —
// подсказка и код 2 (чьё: код — keeper.go keeperVersion; подмена себя сверяет ответ version с планом).
func TestEtVersionAndUsage(t *testing.T) {
	var m struct{ Version string }
	b, _ := os.ReadFile("module.json")
	json.Unmarshal(b, &m)
	if code, out, _ := runKeeper(t, t.TempDir(), "", "version"); code != 0 || strings.TrimSpace(out) != m.Version {
		t.Fatalf("version: код %d, %q, а в module.json %s", code, out, m.Version)
	}
	if code, _, e := runKeeper(t, t.TempDir(), "", "nope"); code != 2 || !strings.Contains(e, "run [--hide]") {
		t.Fatalf("неизвестная команда: код %d, %q", code, e)
	}
	gobin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go нет на машине — сборка с -ldflags не проверена")
	}
	out := filepath.Join(t.TempDir(), exeName("keeper"))
	if o, err := exec.Command(gobin, "build", "-ldflags", "-X main.buildVersion=7.7.7", "-o", out, ".").CombinedOutput(); err != nil {
		t.Fatalf("сборка: %v %s", err, o)
	}
	if v, err := exec.Command(out, "version").Output(); err != nil || strings.TrimSpace(string(v)) != "7.7.7" {
		t.Fatalf("собранный с -ldflags отвечает %q %v", v, err)
	}
}

// Строка журнала флота без связи: журнал не отвечает — строка ledger «offline: …» в журнале машины
// (чьё: код — keeper.go ledger «не дошла — только в журнал машины»; устав: система ловит — пишет с причиной).
func TestEtLedgerWithoutLink(t *testing.T) {
	s := newStand(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().String()
	ln.Close()
	writeConf(s.home, map[string]any{"workers": map[string]any{"relay": "http://" + dead, "ledger": "http://" + dead + "/ledger"}})
	b, _ := json.Marshal(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	os.WriteFile(planPath(s.home), b, 0o600)
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	waitFor(t, "строка ledger без связи", func() bool {
		return journalHas(s.home, `"ev":"ledger","ev":"part.failed","why":"offline: capture 1.3.2 — второе падение`)
	})
}

// relay не принял hello — причина в журнале, вопроса о плане нет, паузы растут и не сбрасываются (устав: система
// ловит — пишет с причиной; «клиенты переподключаются»; чьё: код — relay.go «roster — знак, что hello принят»,
// пауза сбрасывается только после принятого hello).
func TestEtRelayHelloRefused(t *testing.T) {
	var mu sync.Mutex
	var at []time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		at = append(at, time.Now())
		mu.Unlock()
		ws, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		if _, _, err := ws.Read(context.Background()); err == nil {
			ws.Close(websocket.StatusPolicyViolation, "bad_key")
		}
	}))
	t.Cleanup(srv.Close)
	r := newRadio("ws"+strings.TrimPrefix(srv.URL, "http"), "host.win.ab12.sig")
	r.pause0, r.pauseMax = 50*time.Millisecond, time.Second
	opened := false
	var whys []string
	r.onOpen = func() { mu.Lock(); opened = true; mu.Unlock() }
	r.onState = func(open bool, why string) {
		mu.Lock()
		defer mu.Unlock()
		if open {
			opened = true
		} else {
			whys = append(whys, why)
		}
	}
	go r.run()
	t.Cleanup(r.close)
	waitFor(t, "пять попыток", func() bool { mu.Lock(); defer mu.Unlock(); return len(at) >= 5 })
	mu.Lock()
	defer mu.Unlock()
	if opened || len(whys) == 0 || !strings.Contains(whys[0], "bad_key") {
		t.Fatalf("открыто %v, причины %q", opened, whys)
	}
	for i, min := range []time.Duration{50, 100, 200, 400} {
		if gap := at[i+1].Sub(at[i]); gap < min*time.Millisecond {
			t.Fatalf("пауза после отказа %d — %v, меньше %v мс: сброшена без принятого hello", i+1, gap, min)
		}
	}
}

// Ответ «выпусков» — не план v1 (чужое поле части): отказ contract_mismatch, исполняется сохранённый план (план
// заморозки, контракт «план машины v1»: «чужое поле или v≠1 — отказ»; память keeper-freeze: «план… строгие»).
func TestEtPlanReplyNotV1(t *testing.T) {
	s := newStand(t)
	b, _ := json.Marshal(plan1(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
	os.WriteFile(planPath(s.home), b, 0o600)
	extra := s.links.part("capture", "1.4.0", appFiles(""), on)
	extra["args"] = []string{"--x"}
	s.relay.setPlan(plan1(4, extra))
	k := s.start()
	waitFor(t, "отказ", func() bool {
		return journalHas(s.home, `"kind":"refuse","ev":"plan","word":"contract_mismatch","why":"ответ releases.plan — не план v1`)
	})
	waitFor(t, "сохранённый план", func() bool { return partOf(k, "capture").State == "running" })
	if k.state().Rev != 3 || partOf(k, "capture").Version != "1.3.2" {
		t.Fatalf("исполнен чужой план: %+v", k.state())
	}
}

// Планы пришли, пока цикл занят установкой: исполняется старший rev, младший пропущен без строки old_rev (чьё: код —
// keeper.go queue «из ожидающих берётся с большей rev»).
func TestEtPlanQueueTakesNewest(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "rev 1", func() bool { return k.state().Rev == 1 })
	self, _ := os.Executable()
	app := appFiles("")
	b, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "slowsetup"}})
	app["app.json"] = string(b)
	a := s.links.part("capture", "1.0.0", app, on)
	s.relay.push(planMsg(2, a))
	waitFor(t, "setup идёт", func() bool { return exists(filepath.Join(versionDir(s.home, "capture", "1.0.0"), "setup-started")) })
	s.relay.push(planMsg(4, a, s.links.part("probe", "1.0.0", appFiles(""), on)))
	s.relay.push(planMsg(3, a, s.links.part("meter", "1.0.0", appFiles(""), on)))
	waitFor(t, "probe running", func() bool { return partOf(k, "probe").State == "running" })
	time.Sleep(500 * time.Millisecond)
	var saved plan
	b, _ = os.ReadFile(planPath(s.home))
	json.Unmarshal(b, &saved)
	if k.state().Rev != 4 || saved.Rev != 4 || partOf(k, "meter").State != "" || journalHas(s.home, `"word":"old_rev"`) {
		t.Fatalf("rev %d, plan.json %d, meter %+v", k.state().Rev, saved.Rev, partOf(k, "meter"))
	}
}

// Смена версии Host: часть с detach_children запустила держатель сессии — он и его процесс переживают выход прежней
// версии (устав: «обновление Host — по плану, сессии не останавливает»; «Процессы claude держит Host через свои
// держатели»).
func TestEtHostSwitchKeepsSessions(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	host := func(mode string) files {
		run := []string{self, "app"}
		if mode != "" {
			run = append(run, mode)
		}
		b, _ := json.Marshal(map[string]any{"run": run, "detach_children": true})
		return files{"app.json": string(b)}
	}
	s.relay.setPlan(plan1(1, s.links.part("host", "1.0.0", host("host"), on)))
	k := s.start()
	waitFor(t, "держатель сессии", func() bool { return exists(holdPath(s.home, "site@win")) })
	var sess holdFile
	b, _ := os.ReadFile(holdPath(s.home, "site@win"))
	json.Unmarshal(b, &sess)
	s.relay.push(planMsg(2, s.links.part("host", "1.1.0", host(""), on)))
	waitFor(t, "1.1.0 running", func() bool { p := partOf(k, "host"); return p.State == "running" && p.Version == "1.1.0" })
	time.Sleep(500 * time.Millisecond)
	if !alive(sess.Pid) || !alive(sess.Holder) || !exists(holdPath(s.home, "site@win")) {
		t.Fatal("смена версии Host сняла держатель сессии")
	}
}

// Подмена файла не удалась — keeper failed «подмена: …», свой файл прежний, keeper не вышел (устав: система ловит;
// чьё: код — install.go replaceFile «Не вышло — dst прежний», selfUpdate «Сбой — keeper failed, как у любой части»).
func TestEtSelfUpdateReplaceFails(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), exeName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	// копию рядом не записать: на её месте непустая папка
	os.Mkdir(target+".new", 0o700)
	os.WriteFile(filepath.Join(target+".new", "x"), nil, 0o600)
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{osArch() + "/" + exeName("keeper"): string(bin)}, nil)))
	k := s.startWith(func(k *Keeper) { k.self = func() (string, error) { return target, nil } })
	waitFor(t, "failed подмена", func() bool {
		p := partOf(k, "keeper")
		return p.State == "failed" && strings.HasPrefix(p.Error, "подмена: ")
	})
	waitFor(t, "part.failed keeper", func() bool { return s.relay.ledgerHas("part.failed keeper 9.9.9 — подмена: ") })
	select {
	case <-k.Done():
		t.Fatal("keeper вышел после неудачной подмены")
	default:
	}
	if b, _ := os.ReadFile(target); string(b) != "old" {
		t.Fatal("свой файл keeper тронут")
	}
}

// Часть вышла сама, а по исполняемому плану она выключена — stopped без перезапуска (чьё: код — keeper.go
// restartExited «нет в плане или выключена — stopped»).
func TestEtExitedOffStays(t *testing.T) {
	s := newStand(t)
	a := s.links.part("capture", "1.3.2", appFiles("stubborn"), on)
	b := s.links.part("probe", "1.0.0", appFiles(""), on)
	s.relay.setPlan(plan1(1, a, b))
	k := s.start()
	waitFor(t, "обе running", func() bool { return partOf(k, "capture").State == "running" && partOf(k, "probe").State == "running" })
	aOff := s.links.part("capture", "1.3.2", appFiles("stubborn"), map[string]any{"on": false})
	bOff := s.links.part("probe", "1.0.0", appFiles(""), map[string]any{"on": false})
	s.relay.push(planMsg(2, aOff, bOff)) // цикл ждёт упрямую capture, до probe не дошёл
	waitFor(t, "capture stopping", func() bool { return partOf(k, "capture").State == "stopping" })
	killPid(t, partOf(k, "probe").Pid)
	waitFor(t, "probe exited", func() bool { return partOf(k, "probe").State == "exited" })
	aOff["force"] = true
	s.relay.push(planMsg(3, aOff, bOff))
	waitFor(t, "обе stopped", func() bool { return partOf(k, "capture").State == "stopped" && partOf(k, "probe").State == "stopped" })
	time.Sleep(700 * time.Millisecond)
	if p := partOf(k, "probe"); p.State != "stopped" || p.Restarts != 0 || strings.Count(readJournal(s.home), `"ev":"part_start","version":"1.0.0"`) != 1 {
		t.Fatalf("выключенная часть перезапущена: %+v", p)
	}
}

// Перезапуск после падения не встал (версии нет на диске, ссылка истекла) — failed «перезапуск: …» и part.failed
// (устав: система ловит; чьё: код — keeper.go restartExited).
func TestEtRestartInstallFails(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	s.links.expire()
	if err := os.RemoveAll(versionDir(s.home, "capture", "1.3.2")); err != nil {
		t.Fatal(err)
	}
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "failed", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.HasPrefix(p.Error, "перезапуск: download_failed")
	})
	waitFor(t, "part.failed", func() bool {
		return s.relay.ledgerHas("part.failed capture 1.3.2 — перезапуск: download_failed")
	})
}

// Неверные аргументы держателя — отказ словами, код 2, процесс не запущен, файла нет (устав: система ловит;
// чьё: код — hold.go runHold).
func TestEtHoldBadArgs(t *testing.T) {
	self, _ := os.Executable()
	for _, args := range [][]string{{"--id", "../x", "--owner", "keeper", "--", self, "app"}, {"--id", "a", "--owner", "bob", "--", self, "app"},
		{"--id", "a", "--owner", "keeper"}} {
		home := t.TempDir()
		cmd := exec.Command(self, append([]string{"hold"}, args...)...)
		cmd.Env = append(os.Environ(), "SWITCHBOARD_HOME="+home)
		var e strings.Builder
		cmd.Stderr = &e
		cmd.Run()
		if cmd.ProcessState.ExitCode() != 2 || !strings.Contains(e.String(), "нужны --id") || len(readHoldFiles(home)) != 0 {
			t.Fatalf("hold %v: код %d, %q", args, cmd.ProcessState.ExitCode(), e.String())
		}
	}
}

// 5081 · 5082 · 5083 · Соединение — с relay своей машины (/m/<машина> из имени в пропуске); план — POST «Выпускам»
// пропуском машины на каждом соединении; part.failed — POST журналу; адреса — из keeper.json (дизайн «Открытый флот»:
// «keeper — relay своей машины, план на каждом соединении, журнал и приём — POST, адреса — в его настройке»).
func TestEtMachineRelayAndPost(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	s.relay.mu.Lock()
	path, keys := s.relay.path, append([]string(nil), s.relay.keys...)
	s.relay.mu.Unlock()
	if path != "/m/win" || len(keys) == 0 || keys[0] != "host.win.ab12.sig" {
		t.Fatalf("путь relay %q, пропуска POST %v", path, keys)
	}
	asks := s.relay.planAsks()
	s.relay.drop()
	waitFor(t, "план на новом соединении", func() bool { return s.relay.planAsks() > asks })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "part.failed — POST журналу", func() bool { return s.relay.ledgerHas("part.failed capture 1.3.2") })
}
