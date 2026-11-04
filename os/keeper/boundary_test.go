package main

// Леса границы keeper: исполнить план машины. Снаружи: relay, «Выпуски», журнал и gate — поддельные; ОС, держатели и части — настоящие
// процессы этого тестового файла в другой роли. Говорят с кодом через контракт: кадры, POST, файлы на диске, протокол держателя, команды
// файла keeper; мимо процесса — только seam.go. Источники свойств — в комментариях; без пометки — чьё: код.
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
	"reflect"
	"runtime"
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
	if !isThere(filepath.Join(s.home, "parts", "capture", "data")) || !isThere(filepath.Join(s.home, "parts", "capture", "1.3.2", "release.sha256")) {
		t.Fatal("нет папки версии или data/")
	}
	waitFor(t, "вывод в журнале", func() bool { return journalHas(s.home, `"line":"app 1.3.2 start`) })
	var saved savedPlan
	b, _ := os.ReadFile(planFile(s.home))
	if json.Unmarshal(b, &saved) != nil || saved.Rev != 1 || len(saved.Parts) != 1 || saved.Parts[0].Version != "1.3.2" {
		t.Fatalf("plan.json — не ответ «выпусков»: %s", b)
	}
}

// Смена версии без наложения: новая стартует после выхода старой; part.updated; на диске — новая и предыдущая
// (план заморозки: «убрать версии, кроме текущей и предыдущей»).
func TestEtVersionSwitchNoOverlap(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "1.3.2 running", func() bool { return partOf(k, "capture").State == "running" })
	os.MkdirAll(verDir(s.home, "capture", "0.9.0"), 0o700) // версия позапрошлой выкладки
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "1.4.0 running", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Version == "1.4.0" })
	waitFor(t, "part.updated", func() bool { return s.relay.ledgerHas("part.updated capture 1.3.2 → 1.4.0") })
	// новый план исполнен целиком: keeper.state и plan.json — rev 2 (план заморозки: «хранить на диске»)
	var saved savedPlan
	b0, _ := os.ReadFile(planFile(s.home))
	if json.Unmarshal(b0, &saved) != nil || saved.Rev != 2 || stateOf(k).Rev != 2 {
		t.Fatalf("rev после кадра плана: plan.json %d, keeper.state %d", saved.Rev, stateOf(k).Rev)
	}
	// старая вышла сама после закрытого ввода («bye») раньше, чем стартовала новая
	waitFor(t, "строка старта 1.4.0", func() bool { return journalHas(s.home, `"line":"app 1.4.0 start`) })
	b := readJournal(s.home)
	bye, start := strings.Index(b, `"line":"bye"`), strings.Index(b, `"line":"app 1.4.0 start`)
	if bye < 0 || start < 0 || bye > start {
		t.Fatalf("наложение версий: bye=%d start=%d", bye, start)
	}
	if !isThere(verDir(s.home, "capture", "1.3.2")) {
		t.Fatal("предыдущая версия убрана — отката без скачивания не будет")
	}
	waitFor(t, "позапрошлая версия убрана", func() bool { return !isThere(verDir(s.home, "capture", "0.9.0")) })
	es, _ := os.ReadDir(partFolder(s.home, "capture"))
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
	k := s.startWith(tuning{stop: 1500 * time.Millisecond})
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
	k := s.startWith(tuning{stop: 1500 * time.Millisecond})
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
	if isThere(stampFile(verDir(s.home, "capture", "1.4.0"))) {
		t.Fatal("версия с зависшим setup отмечена готовой")
	}
}

// 3146 · новый файл keeper не ответил на version за предел — убит, keeper failed check_failed, keeper не выходит.
func TestEtSelfCheckLimit(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION_HANG", "1")
	kp := s.links.part("keeper", "9.9.9", files{archDir() + "/" + binName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, kp))
	k := s.startWith(tuning{stop: 1500 * time.Millisecond})
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
				getFrame(c)
				b, _ := json.Marshal(map[string]any{"pid": pid, "buffered": 0})
				putFrame(c, kHello, b)
				for {
					if _, _, err := getFrame(c); err != nil {
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
	os.MkdirAll(heldDir(s.home), 0o700)
	putHeldFile(s.home, heldFile{ID: "capture", Owner: "keeper", Pid: os.Getpid(), Port: silentHolder(t), Key: "k", Tag: "1.3.2"})
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
	os.MkdirAll(heldDir(s.home), 0o700)
	// процесс части — отдельный: уборка стенда убивает держателей по pid из их файлов
	self, _ := os.Executable()
	child := exec.Command(self, "app", "deaf")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { child.Process.Kill(); child.Wait() })
	putHeldFile(s.home, heldFile{ID: "capture", Owner: "keeper", Pid: child.Process.Pid, Port: deafHolder(t, child.Process.Pid), Key: "k", Tag: "1.3.2"})
	p1 := plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on))
	b, _ := json.Marshal(p1)
	os.WriteFile(planFile(s.home), b, 0o600)
	s.relay.setPlan(p1)
	k := s.startWith(tuning{stop: 700 * time.Millisecond})
	waitFor(t, "adopt", func() bool { return partOf(k, "capture").State == "running" })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	s.relay.push(planMsg(2, s.links.part("capture", "1.4.0", appFiles(""), on)))
	waitFor(t, "failed после «убей»", func() bool { return partOf(k, "capture").State == "failed" })
	if !journalHas(s.home, `не вышла и за 700ms после «убей»`) || journalHas(s.home, `"ev":"part_start","version":"1.4.0"`) {
		t.Fatal("нет stop_late после «убей» или новая версия запущена рядом с прежней")
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

// 3167 · Запись keeper с работающей версией — без подмены себя и без строк о ней (чьё: код).
func TestEtKeeperSameVersionNoUpdate(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("keeper", ourVersion, files{"x": "y"}, nil), s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "capture running", func() bool { return partOf(k, "capture").State == "running" })
	time.Sleep(500 * time.Millisecond)
	select {
	case <-k.Done():
		t.Fatal("keeper вышел")
	default:
	}
	if journalHas(s.home, `"ev":"self_update"`) || journalHas(s.home, `"part":"keeper","version":"`+ourVersion+`"`) && partOf(k, "keeper").State == "failed" {
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
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.3.2 — второе падение: ") })
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
	os.WriteFile(planFile(s.home), b, 0o600)
	saveConf(s.home, map[string]any{}) // relay нет
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	putHeldFile(s.home, heldFile{ID: "capture", Owner: "keeper", Port: port, Key: "dead", Tag: "1.3.2"})
	k := s.start()
	waitFor(t, "running без связи", func() bool { return partOf(k, "capture").State == "running" })
	for _, want := range []string{`"kind":"stop","ev":"relay","why":"в keeper.json нет адреса relay (workers.relay) или нет machine.key — исполняю сохранённый план без связи"`,
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

// 5507 · Процесс вышел, хозяина нет — держатель ждёт его не дольше ownerWait: строка held_unclaimed, файл убран,
// держатель вышел (ubuntu-db 3 нояб.: после снятия keeper держатель Host ждал хозяина без предела; устав: «у всех
// операций лимит»).
func TestEtHolderUnclaimedExit(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=300ms"), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf heldFile
	b, _ := os.ReadFile(heldPath(home, "s"))
	json.Unmarshal(b, &hf)
	killPid(t, f.Pid)
	waitFor(t, "держатель вышел", func() bool { return !isThere(heldPath(home, "s")) && !alive(hf.Holder) })
	if !journalHas(home, `"ev":"held_unclaimed"`) || !journalHas(home, "хозяин не забрал выход за 300ms — держатель вышел") || !journalHas(home, `"ev":"held_exit"`) {
		t.Fatal("нет строки held_exit или held_unclaimed с причиной")
	}
}

// 5509 · Хозяин получил выход и держит соединение — держатель всё равно выходит через ownerWait: файл убран, строки
// held_unclaimed нет — выход забран (устав: «у всех операций лимит»; чьё: код — unclaimed).
func TestEtHolderExitTakenOwnerStays(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=300ms"), Cmd: []string{self, "app"}})
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
	defer c.Close()
	c.closeInput()
	if x, err := c.read(func([]byte) {}); err != nil || x == nil {
		t.Fatalf("выход %+v %v", x, err)
	}
	// соединение остаётся открытым
	waitFor(t, "держатель вышел", func() bool { return !isThere(heldPath(home, "s")) && !alive(hf.Holder) })
	if journalHas(home, `"ev":"held_unclaimed"`) {
		t.Fatal("held_unclaimed при забранном выходе")
	}
}

// 5511 · keeper вернулся после того, как держатель ушёл по ownerWait: файла нет — часть запущена по сохранённому плану
// заново (новый pid, part_start), restarts 0, part.failed нет (устав, закрытый список: «часть машины … умерла — один
// перезапуск»; чьё: код — run: adopt, затем queue(plan) — выход без держателя не считается падением).
func TestEtKeeperBackAfterUnclaimed(t *testing.T) {
	t.Setenv("KEEPER_TEST_OWNER_WAIT", "300ms")
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	k.Stop()
	killPid(t, pid)
	waitFor(t, "held_unclaimed", func() bool {
		return journalHas(s.home, `"ev":"held_unclaimed"`) && !isThere(heldPath(s.home, "capture"))
	})
	k2 := s.start()
	waitFor(t, "часть запущена заново", func() bool {
		p := partOf(k2, "capture")
		return p.State == "running" && p.Pid != pid && p.Pid != 0
	})
	if p := partOf(k2, "capture"); p.Restarts != 0 || strings.Count(readJournal(s.home), `"ev":"part_start"`) != 2 || s.relay.ledgerHas("part.failed") {
		t.Fatalf("часть %+v, стартов %d", p, strings.Count(readJournal(s.home), `"ev":"part_start"`))
	}
}

// 5513 · Процесс жив дольше ownerWait — держатель ждёт хозяина: файл на месте, held_unclaimed нет, хозяин получает
// тот же pid; предел считается только от выхода процесса (устав, закрытый список: «держатели живут, keeper
// подключается к своим»; чьё: код — таймер ownerWait заводится в pump после выхода процесса).
func TestEtHolderLiveProcessOutlastsOwnerWait(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=300ms"), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	if !isThere(heldPath(home, "s")) || journalHas(home, `"ev":"held_unclaimed"`) {
		t.Fatal("держатель живого процесса ушёл")
	}
	c, hh, err := attachHeld(f)
	if err != nil || hh.Pid != f.Pid {
		t.Fatalf("hello %+v %v", hh, err)
	}
	c.Close()
}

// 5518 · Соединение без кадра ключа держатель закрывает за 10 с словом bad_key; держатель и процесс живут, хозяин с
// ключом подключается (устав: «у всех операций должен быть лимит», слово пользователя 2 нояб.).
func TestEtHolderNoKeyClosed(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := holdProc(home, holdReq{ID: "s", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	start := time.Now()
	raw.SetReadDeadline(time.Now().Add(15 * time.Second))
	ty, body, err := getFrame(raw)
	if err != nil || ty != kError || string(body) != "bad_key" || time.Since(start) < 9*time.Second {
		t.Fatalf("кадр %q %q %v за %v", ty, body, err, time.Since(start))
	}
	if !alive(f.Pid) {
		t.Fatal("процесс умер")
	}
	c, hh, err := attachHeld(f)
	if err != nil || hh.Pid != f.Pid {
		t.Fatalf("хозяин не подключился: %+v %v", hh, err)
	}
	c.Close()
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
	if res["keeper"] != ourVersion || res["rev"].(float64) != 3 || res["os"] == "" {
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

/* ===== держатель ===== */

// Держатель копит вывод без хозяина и отдаёт его хозяину; второй хозяин вытесняет первого; чужой ключ — bad_key
// (чьё: код — «Протокол держателя — заморожен», «Подключается к нему только хозяин, по ключу»; план заморозки,
// «Держатель»: «накопление без хозяина»).
func TestEtHolderBufferAndOwner(t *testing.T) {
	// байты кадра — образец замороженного протокола; тот же образец проверяет Host
	var gb bytes.Buffer
	putFrame(&gb, kAuth, []byte("key"))
	if gb.String() != "a\x00\x00\x00\x03key" {
		t.Fatalf("кадр %q", gb.String())
	}
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := holdProc(home, holdReq{ID: "x", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app"}})
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
	c1 := &ownerConn{c: raw}
	var first strings.Builder
	firstDone := make(chan error, 1)
	go func() {
		x, err := c1.read(func(b []byte) { first.Write(b) })
		if x != nil {
			err = fmt.Errorf("прежнему хозяину отдан выход %+v", x)
		}
		firstDone <- err
	}()
	c2, hh, err := attachHeld(f)
	if err != nil || hh.Pid != f.Pid {
		t.Fatalf("второй хозяин: %+v %v", hh, err)
	}
	if err := <-firstDone; err == nil || !strings.Contains(first.String(), "app 1 start") {
		t.Fatalf("прежний хозяин не вытеснен или без накопленного: %v %q", err, first.String())
	}
	waitFor(t, "строка held_replaced", func() bool { return journalHas(home, `"ev":"held_replaced"`) && journalHas(home, `"ev":"held_attach"`) })
	bad := f
	bad.Key = "nope"
	if _, _, err := attachHeld(bad); err == nil || !strings.Contains(err.Error(), "bad_key") {
		t.Fatalf("чужой ключ: %v", err)
	}
	// выход процесса — у второго хозяина
	c2.closeInput()
	if x, err := c2.read(func([]byte) {}); err != nil || x == nil {
		t.Fatalf("выход второму хозяину %v %v", x, err)
	}
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
	dir := verDir(s.home, "capture", "1.3.2")
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
	waitFor(t, "план rev 1", func() bool { return stateOf(k).Rev == 1 })
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
	for _, w := range []string{"план не от .releases: phone~x@y", "кадр releases.plan v 2 — не v1", "кадр releases.plan — не план v1: "} {
		if !journalHas(s.home, w) {
			t.Fatalf("нет причины %q", w)
		}
	}
	time.Sleep(300 * time.Millisecond)
	if stateOf(k).Rev != 1 || partOf(k, "capture").State != "" {
		t.Fatalf("отклонённый план исполнен: %+v", stateOf(k))
	}
}

// План старше исполняемого не исполняется — строка refuse old_rev (чьё: код — keeper.go «меньшая — «выпуски»
// потеряли счёт: такой план не исполняется, строка в журнале»).
func TestEtPlanOldRev(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(5))
	k := s.start()
	waitFor(t, "rev 5", func() bool { return stateOf(k).Rev == 5 })
	s.relay.push(planMsg(3, s.links.part("capture", "1.0.0", appFiles(""), on)))
	waitFor(t, "old_rev", func() bool { return journalHas(s.home, `"word":"old_rev"`) })
	if n := strings.Count(readJournal(s.home), `"word":"old_rev"`); n != 1 || stateOf(k).Rev != 5 || partOf(k, "capture").State != "" {
		t.Fatalf("строк old_rev %d, rev %d", n, stateOf(k).Rev)
	}
	if !journalHas(s.home, "план rev 3 старше исполняемого rev 5") {
		t.Fatal("нет причины old_rev")
	}
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
	waitFor(t, "setup идёт", func() bool { return isThere(filepath.Join(verDir(s.home, "capture", "1.4.0"), "setup-started")) })
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
	noRun := s.links.part("tuner", "1.0.0", files{"app.json": "{}"}, on)
	noLink := s.links.part("gauge", "1.0.0", appFiles(""), on)
	delete(noLink, "url")
	gone := s.links.part("dial", "1.0.0", appFiles(""), on)
	gone["url"] = gone["url"].(string) + "-нет"
	escape := s.links.part("relay", "1.0.0", files{"../x": "y"}, on)
	s.relay.setPlan(plan1(1, bad, link, s.links.part("meter", "1.0.0", foreign, on), s.links.part("web", "1.0.0", setup, on), noApp, badName, noRun, noLink, gone, escape))
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
	for part, want := range map[string]string{
		"capture": "download_failed: sha256 capture 1.0.0 — ",
		"probe":   "download_failed: распаковка: запись link вида '2' — в архиве части только файлы и папки",
		"meter":   "contract_mismatch: app.json: ",
		"web":     "setup_failed: ",
		"radar":   "no_app_json: ",
		"sonar":   "bad_plan: часть «sonar» версия «1.0.0/../x»",
		"tuner":   "app.json без run",
		"gauge":   "download_failed: gauge 1.0.0 нет на диске и нет ссылки",
		"dial":    "download_failed: GET dial 1.0.0: 404",
		"relay":   "download_failed: распаковка: путь вне папки: ../x",
	} {
		waitFor(t, part+" failed", func() bool { return strings.HasPrefix(partOf(k, part).Error, want) })
	}
	if !strings.Contains(partOf(k, "web").Error, "npm ERR! нет пакета") {
		t.Fatalf("причина setup: %q", partOf(k, "web").Error)
	}
	if isThere(verDir(s.home, "web", "1.0.0")) {
		t.Fatal("папка версии с упавшим setup осталась")
	}
}

// Часть убрана из плана: остановлена штатно и снята из keeper.state, папки версий убраны, data/ осталась.
func TestEtPartRemoved(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	keep := filepath.Join(partFolder(s.home, "capture"), "data", "keep")
	os.WriteFile(keep, []byte("1"), 0o600)
	s.relay.push(planMsg(2))
	waitFor(t, "снята", func() bool { return len(stateOf(k).Parts) == 0 })
	// папки версий keeper убирает после того, как снял часть из keeper.state
	waitFor(t, "папка версии убрана", func() bool { return !isThere(verDir(s.home, "capture", "1.3.2")) })
	if !isThere(keep) {
		t.Fatal("data/ убрана")
	}
	if !journalHas(s.home, `"line":"bye"`) || !journalHas(s.home, `"part":"capture"`) || !journalHas(s.home, `"ev":"part_removed"`) {
		t.Fatal("часть не остановлена закрытием ввода или нет строки part_removed")
	}
}

// Приложение получает от keeper окружение машины и окружение из плана; рабочая папка процесса — data части
// (чьё: код — startPart, Cwd: data).
func TestEtPartEnv(t *testing.T) {
	s := newStand(t)
	p := s.links.part("capture", "1.3.2", appFiles("env"), on)
	p["env"] = map[string]string{"SITE": "lab"}
	s.relay.setPlan(plan1(1, p))
	s.start()
	waitFor(t, "строка env", func() bool { return journalHas(s.home, `"line":"env `) })
	line, _ := journalLine(s.home, `"line":"env `)["line"].(string)
	self, _ := os.Executable()
	data := filepath.Join(partFolder(s.home, "capture"), "data")
	for _, want := range []string{"SWITCHBOARD_MACHINE=win", "SWITCHBOARD_VERSION=1.3.2", "SWITCHBOARD_DATA=" + data,
		"SWITCHBOARD_HOME=" + s.home, "SWITCHBOARD_HOLDER=" + self, "SWITCHBOARD_RELAY= ", "SWITCHBOARD_WORKERS={", "SITE=lab", "CWD=" + data} {
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
	f, err := holdProc(home, holdReq{ID: "d", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app", "deaf"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	go func() {
		chunk := make([]byte, 32*1024)
		for i := 0; i < 8; i++ {
			if c.send(kInput, chunk) != nil {
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
	waitFor(t, "setup идёт", func() bool { return isThere(filepath.Join(verDir(s.home, "capture", "1.4.0"), "setup-started")) })
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
	if !alive(pid) || !isThere(heldPath(s.home, "capture")) {
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
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{archDir() + "/" + binName("keeper"): string(bin)}, nil)))
	k := s.start()
	waitFor(t, "check_failed", func() bool { return strings.Contains(partOf(k, "keeper").Error, "check_failed") })
	s.relay.push(planMsg(2, s.links.part("keeper", ourVersion, files{"x": "x"}, nil)))
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

// 5175 · «Выпуски» не ответили на вопрос о плане — строка журнала, соединение с relay своей машины не трогается;
// план приходит кадром releases.plan (источник: отчёт слепого архитектора 2 нояб., пункт 7 — лишняя коммуникация:
// повтор через переподключение relay; устав «система ловит, агент чинит» — без обходных путей).
func TestEtPlanNoAnswerNoReconnect(t *testing.T) {
	s := newStand(t)
	s.relay.setSilent(1)
	k := s.startWith(tuning{planWait: 500 * time.Millisecond})
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
	target := filepath.Join(t.TempDir(), binName("keeper"))
	os.WriteFile(target, []byte("cur"), 0o755)
	olds := []string{target + ".0.9.0.4242.old", target + ".prev.77.old"}
	for _, o := range olds {
		os.WriteFile(o, []byte("old"), 0o755)
	}
	s.relay.setPlan(plan1(1))
	k := s.startWith(tuning{self: func() (string, error) { return target, nil }})
	waitFor(t, "план rev 1", func() bool { return stateOf(k).Rev == 1 })
	for _, o := range olds {
		if isThere(o) {
			t.Fatalf("прежний файл не убран: %s", o)
		}
	}
	if !isThere(target) {
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
	os.WriteFile(planFile(s.home), b, 0o600)
	s.relay.setRefuse("cf_failed")
	k := s.start()
	waitFor(t, "строка отказа", func() bool { return journalHas(s.home, `"kind":"refuse","ev":"plan","word":"cf_failed"`) })
	waitFor(t, "сохранённый план", func() bool { return partOf(k, "capture").State == "running" })
	time.Sleep(700 * time.Millisecond)
	if stateOf(k).Rev != 3 || s.relay.planAsks() != 1 {
		t.Fatalf("rev %d, вопросов %d", stateOf(k).Rev, s.relay.planAsks())
	}
	if !journalHas(s.home, "releases.plan не ответил: cf_failed") {
		t.Fatal("нет причины отказа")
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

// Умер держатель части — связь с ним оборвалась без кадра выхода: это падение части, один перезапуск с причиной
// «связь с держателем оборвалась»; процесс ушёл вместе с держателем (устав, закрытый список: «умерла — один перезапуск»).
func TestEtHolderDiedPartRestarts(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	var hf heldFile
	b, _ := os.ReadFile(heldPath(s.home, "capture"))
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
	fp, err := holdProc(home, holdReq{ID: "capture", Owner: "keeper", Tag: "1.3.2", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1.3.2"), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	fh, err := holdProc(home, holdReq{ID: "site@win", Owner: "host", Env: os.Environ(), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []heldFile{fp, fh} {
		var disk heldFile
		b, _ := os.ReadFile(heldPath(home, f.ID))
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

// Ввод доходит до процесса по порядку, «закрой ввод» — после всего ввода из очереди; процесс вышел кодом 0
// (план заморозки, «Держатель»: «процесс, его ввод и вывод… Им же пользуется Host для сессий»; находка «Убей»:
// «„Закрой ввод“ встаёт в очередь за вводом»).
func TestEtHolderInputInOrder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	f, err := holdProc(home, holdReq{ID: "e", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app", "echo"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range []string{"a\n", "b\n", "c\n"} {
		c.send(kInput, []byte(l))
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
	f, err := holdProc(home, holdReq{ID: "w", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app", "chatty"}})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	go c.read(func([]byte) {})
	time.Sleep(200 * time.Millisecond)
	c.Close()
	time.Sleep(300 * time.Millisecond)
	c2, hh, err := attachHeld(f)
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
	f, err := holdProc(home, holdReq{ID: "p", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app", "parent"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf heldFile
	b, _ := os.ReadFile(heldPath(home, "p"))
	json.Unmarshal(b, &hf)
	c, _, err := attachHeld(f)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var out strings.Builder
	type res struct {
		x   *heldExit
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
	waitFor(t, "файл держателя убран", func() bool { return !isThere(heldPath(home, "p")) })
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
	f, err := holdProc(home, holdReq{ID: "slow", Owner: "host", Env: append(os.Environ(), "SWITCHBOARD_VERSION=1"), Cmd: []string{self, "app"}})
	if err != nil {
		t.Fatal(err)
	}
	var hf heldFile
	b, _ := os.ReadFile(heldPath(home, "slow"))
	json.Unmarshal(b, &hf)
	time.Sleep(500 * time.Millisecond) // строка о старте написана
	killPid(t, f.Pid)
	waitFor(t, "процесс убит", func() bool { return !alive(f.Pid) })
	time.Sleep(500 * time.Millisecond)
	if !isThere(heldPath(home, "slow")) || !alive(hf.Holder) {
		t.Fatal("держатель не дождался хозяина")
	}
	raw, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port))
	if err != nil {
		t.Fatal(err)
	}
	if err := putFrame(raw, kAuth, []byte(f.Key)); err != nil {
		t.Fatal(err)
	}
	// хозяин занят: держатель успевает отдать hello, накопленное и выход раньше, чем хозяин читает
	time.Sleep(time.Second)
	ty, body, err := getFrame(raw)
	if err != nil || ty != kHello {
		t.Fatalf("hello: %q %v", ty, err)
	}
	var hh heldHello
	json.Unmarshal(body, &hh)
	var out strings.Builder
	x, err := (&ownerConn{c: raw}).read(func(b []byte) { out.Write(b) })
	killed := x != nil && ((x.Code != nil && *x.Code == 3) || (x.Signal != nil && *x.Signal == "SIGKILL"))
	if hh.Pid != f.Pid || err != nil || !killed || !strings.Contains(out.String(), "app 1 start") {
		t.Fatalf("hello %+v, выход %+v %v, вывод %q", hh, x, err, out.String())
	}
	// хозяин закрыл соединение — держатель убрал файл и вышел
	raw.Close()
	waitFor(t, "файл держателя убран", func() bool { return !isThere(heldPath(home, "slow")) })
	waitFor(t, "держатель вышел", func() bool { return !alive(hf.Holder) })
}

/* ===== цикл тестов 1–2 нояб. (ночь): сценарии плана без эталона ===== */

// Штатная остановка закрывает связь с relay, и keeper больше не подключается (устав: «Каждая часть… останавливается
// штатно: …закрывает соединения… → выходит»). Слова причины закрытия relay пишет только в свой журнал — их не
// проверяем (цикл 2 нояб.: под нагрузкой кадр закрытия уходит не всегда; не находка — текст журнала relay).
func TestEtStopClosesLink(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "план rev 1", func() bool { return stateOf(k).Rev == 1 })
	k.Stop()
	time.Sleep(1500 * time.Millisecond)
	if _, opens := s.relay.seen(); opens != 1 {
		t.Fatalf("после остановки keeper подключился снова: входов %d", opens)
	}
}

// version — номер выпуска: собранный с -ldflags отвечает им, без него — версией из module.json; неизвестная команда —
// подсказка и код 2 (чьё: код — keeper.go ourVersion; подмена себя сверяет ответ version с планом).
func TestEtVersionAndUsage(t *testing.T) {
	var m struct{ Version string }
	b, _ := os.ReadFile("module.json")
	json.Unmarshal(b, &m)
	if code, out, _ := runKeeper(t, t.TempDir(), "", "version"); code != 0 || strings.TrimSpace(out) != m.Version {
		t.Fatalf("version: код %d, %q, а в module.json %s", code, out, m.Version)
	}
	if code, _, e := runKeeper(t, t.TempDir(), "", "nope"); code != 2 || !strings.Contains(e, "run [--hide] | install [--worker <имя>=<https>]… [--logon] | uninstall | hold … | version; у run, install, uninstall — [--name <имя>]") {
		t.Fatalf("неизвестная команда: код %d, %q", code, e)
	}
	gobin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go нет на машине — сборка с -ldflags не проверена")
	}
	out := filepath.Join(t.TempDir(), binName("keeper"))
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
	saveConf(s.home, map[string]any{"workers": map[string]any{"relay": "http://" + dead, "ledger": "http://" + dead + "/ledger"}})
	b, _ := json.Marshal(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	os.WriteFile(planFile(s.home), b, 0o600)
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "failed", func() bool { return partOf(k, "capture").State == "failed" })
	waitFor(t, "строка ledger без связи", func() bool {
		return journalHas(s.home, `"ev":"ledger","event":"part.failed","why":"offline: capture 1.3.2 — второе падение`)
	})
}

// Ответ «выпусков» — не план v1 (чужое поле части): отказ contract_mismatch, исполняется сохранённый план (план
// заморозки, контракт «план машины v1»: «чужое поле или v≠1 — отказ»; память keeper-freeze: «план… строгие»).
func TestEtPlanReplyNotV1(t *testing.T) {
	s := newStand(t)
	b, _ := json.Marshal(plan1(3, s.links.part("capture", "1.3.2", appFiles(""), on)))
	os.WriteFile(planFile(s.home), b, 0o600)
	extra := s.links.part("capture", "1.4.0", appFiles(""), on)
	extra["args"] = []string{"--x"}
	s.relay.setPlan(plan1(4, extra))
	k := s.start()
	waitFor(t, "отказ", func() bool {
		return journalHas(s.home, `"kind":"refuse","ev":"plan","word":"contract_mismatch","why":"ответ releases.plan — не план v1`)
	})
	waitFor(t, "сохранённый план", func() bool { return partOf(k, "capture").State == "running" })
	if stateOf(k).Rev != 3 || partOf(k, "capture").Version != "1.3.2" {
		t.Fatalf("исполнен чужой план: %+v", stateOf(k))
	}
}

// Планы пришли, пока цикл занят установкой: исполняется старший rev, младший пропущен без строки old_rev (чьё: код —
// keeper.go queue «из ожидающих берётся с большей rev»).
func TestEtPlanQueueTakesNewest(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1))
	k := s.start()
	waitFor(t, "rev 1", func() bool { return stateOf(k).Rev == 1 })
	self, _ := os.Executable()
	app := appFiles("")
	b, _ := json.Marshal(map[string]any{"run": []string{self, "app"}, "setup": []string{self, "slowsetup"}})
	app["app.json"] = string(b)
	a := s.links.part("capture", "1.0.0", app, on)
	s.relay.push(planMsg(2, a))
	waitFor(t, "setup идёт", func() bool { return isThere(filepath.Join(verDir(s.home, "capture", "1.0.0"), "setup-started")) })
	s.relay.push(planMsg(4, a, s.links.part("probe", "1.0.0", appFiles(""), on)))
	s.relay.push(planMsg(3, a, s.links.part("meter", "1.0.0", appFiles(""), on)))
	waitFor(t, "probe running", func() bool { return partOf(k, "probe").State == "running" })
	time.Sleep(500 * time.Millisecond)
	var saved savedPlan
	b, _ = os.ReadFile(planFile(s.home))
	json.Unmarshal(b, &saved)
	if stateOf(k).Rev != 4 || saved.Rev != 4 || partOf(k, "meter").State != "" || journalHas(s.home, `"word":"old_rev"`) {
		t.Fatalf("rev %d, plan.json %d, meter %+v", stateOf(k).Rev, saved.Rev, partOf(k, "meter"))
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
	waitFor(t, "держатель сессии", func() bool { return isThere(heldPath(s.home, "site@win")) })
	var sess heldFile
	b, _ := os.ReadFile(heldPath(s.home, "site@win"))
	json.Unmarshal(b, &sess)
	s.relay.push(planMsg(2, s.links.part("host", "1.1.0", host(""), on)))
	waitFor(t, "1.1.0 running", func() bool { p := partOf(k, "host"); return p.State == "running" && p.Version == "1.1.0" })
	time.Sleep(500 * time.Millisecond)
	if !alive(sess.Pid) || !alive(sess.Holder) || !isThere(heldPath(s.home, "site@win")) {
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
	target := filepath.Join(t.TempDir(), binName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	// копию рядом не записать: на её месте непустая папка
	os.Mkdir(target+".new", 0o700)
	os.WriteFile(filepath.Join(target+".new", "x"), nil, 0o600)
	s.relay.setPlan(plan1(1, s.links.part("keeper", "9.9.9", files{archDir() + "/" + binName("keeper"): string(bin)}, nil)))
	k := s.startWith(tuning{self: func() (string, error) { return target, nil }})
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
	if err := os.RemoveAll(verDir(s.home, "capture", "1.3.2")); err != nil {
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
		if cmd.ProcessState.ExitCode() != 2 || !strings.Contains(e.String(), "hold: нужны --id, --owner keeper|host и команда после --") || len(heldFiles(home)) != 0 {
			t.Fatalf("hold %v: код %d, %q", args, cmd.ProcessState.ExitCode(), e.String())
		}
	}
}

// nameStand — домашняя папка пользователя в temp и прежние правила имени после эталона.
func nameStand(t *testing.T) string {
	t.Helper()
	u := t.TempDir()
	t.Setenv("HOME", u)
	t.Setenv("USERPROFILE", u)
	t.Setenv("SWITCHBOARD_HOME", "")
	clearFleet()
	t.Cleanup(clearFleet)
	return u
}

// 5522 · Без имени — служба и папка прежние, команда run; имя с путём — отказ словом (дизайн этапа 0).
func TestEtNameAbsentSameAsBefore(t *testing.T) {
	u := nameStand(t)
	rest, err := chooseFleet([]string{"--hide"})
	if err != nil || !reflect.DeepEqual(rest, []string{"--hide"}) {
		t.Fatalf("%v %v", rest, err)
	}
	home, _ := fleetHome()
	if fleetService() != "switchboard-keeper" || home != filepath.Join(u, ".switchboard") || !reflect.DeepEqual(fleetCommand(), []string{"run"}) {
		t.Fatalf("служба %q, папка %q, команда %v", fleetService(), home, fleetCommand())
	}
	for _, bad := range [][]string{{"--name"}, {"--name", "../x"}, {"--name", ""}} {
		if _, err := chooseFleet(bad); err == nil || err.Error() != "--name <имя> — без путей" {
			t.Fatalf("%v: %v", bad, err)
		}
	}
	if code, _, e := runKeeper(t, t.TempDir(), "", "install", "--worker", "x"); code != 1 || !strings.Contains(e, `--worker <имя>=<https://…>, а не "x"`) {
		t.Fatalf("плохой --worker: код %d, %q", code, e)
	}
}

// journalText — весь журнал папки одной строкой.
func journalText(home string) string {
	ms, _ := filepath.Glob(filepath.Join(home, "journal", "*.jsonl"))
	var out strings.Builder
	for _, m := range ms {
		b, _ := os.ReadFile(m)
		out.Write(b)
	}
	return out.String()
}

// namedKeeper — keeper run --name отдельным процессом: папка ~/.switchboard-<имя>, relay и «Выпуски» со своего стенда, одна часть.
type namedKeeper struct {
	t    *testing.T
	own  string
	name string
	cmd  *exec.Cmd
}

func newNamedKeeper(t *testing.T, u, name string) *namedKeeper {
	t.Helper()
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	own := filepath.Join(u, ".switchboard-"+name)
	os.MkdirAll(own, 0o700)
	for _, f := range []string{"machine.key", "keeper.json"} {
		b, err := os.ReadFile(filepath.Join(s.home, f))
		if err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(own, f), b, 0o600)
	}
	t.Cleanup(func() { killHolders(own) })
	n := &namedKeeper{t: t, own: own, name: name}
	t.Cleanup(n.kill)
	n.run()
	return n
}

// run — та же команда, какой его поднимает ОС.
func (n *namedKeeper) run() {
	n.t.Helper()
	self, _ := os.Executable()
	n.cmd = exec.Command(self, "keeper", "run", "--name", n.name)
	n.cmd.Env = os.Environ()
	if err := n.cmd.Start(); err != nil {
		n.t.Fatal(err)
	}
}

func (n *namedKeeper) kill() {
	if n.cmd.ProcessState == nil {
		n.cmd.Process.Kill()
		n.cmd.Wait()
	}
}

// partPid — pid части: из строки part_start своего журнала.
func (n *namedKeeper) partPid() int {
	n.t.Helper()
	waitFor(n.t, "часть "+n.name, func() bool { return journalHas(n.own, `"ev":"part_start"`) })
	return int(journalLine(n.own, `"ev":"part_start"`)["pid"].(float64))
}

// 5564 · Держатель имя не разбирает: --name в команде процесса доходит до процесса как есть, папка держателя — из
// SWITCHBOARD_HOME (дизайн этапа 0: «Host и держателям папку передаёт в SWITCHBOARD_HOME — они её не выводят»).
func TestEtHoldDoesNotParseName(t *testing.T) {
	u := nameStand(t)
	home := t.TempDir()
	t.Cleanup(func() { killHolders(home) })
	self, _ := os.Executable()
	cmd := exec.Command(self, "keeper", "hold", "--id", "s", "--owner", "keeper", "--", self, "app", "args", "--name", "y")
	cmd.Env = append(os.Environ(), "SWITCHBOARD_HOME="+home)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	waitFor(t, "файл держателя", func() bool { return len(heldFiles(home)) == 1 })
	c, _, err := attachHeld(heldFiles(home)[0])
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.closeInput()
	var out strings.Builder
	c.read(func(b []byte) { out.Write(b) })
	if !strings.Contains(out.String(), "args args --name y") {
		t.Fatalf("вывод процесса: %q", out.String())
	}
	if _, err := os.Stat(filepath.Join(u, ".switchboard-y")); !os.IsNotExist(err) {
		t.Fatalf("папка по имени из команды процесса: %v", err)
	}
}

// 5565 · Приглашение не принято — отказ словом с причиной от gate; службы, задачи, юнита и папки этого имени нет, первый
// флот не тронут (устав «система ловит»; чьё: код — prepareConf «погашенное или чужое — отказ словом»).
func TestEtNameInviteRefused(t *testing.T) {
	u := nameStand(t)
	t.Setenv("XDG_CONFIG_HOME", u)
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"type": "reply", "id": "install", "ok": false, "error": "bad_invite"})
	}))
	defer gate.Close()
	name := fmt.Sprintf("t%dr", os.Getpid())
	code, _, e := runKeeper(t, t.TempDir(), "invite\n", "install", "--name", name, "--worker", "gate="+gate.URL)
	if code != 1 || !strings.Contains(e, "приглашение не принято") || !strings.Contains(e, "bad_invite") {
		t.Fatalf("код %d, %q", code, e)
	}
	for _, p := range []string{".switchboard-" + name, ".switchboard", filepath.Join("systemd", "user", "switchboard-keeper-"+name+".service")} {
		if _, err := os.Stat(filepath.Join(u, p)); !os.IsNotExist(err) {
			t.Fatalf("%s появилось: %v", p, err)
		}
	}
	if runtime.GOOS == "windows" {
		if exec.Command("schtasks", "/Query", "/TN", "switchboard-keeper-"+name).Run() == nil || exec.Command("sc", "query", "switchboard-keeper-"+name).Run() == nil {
			t.Fatal("служба или задача создана")
		}
	}
}

/* ===== слитые при триаже: один флоу — один тест ===== */

// Новая версия отклонена до остановки прежней (404, setup упал, чужой хэш, чужое поле app.json) — прежняя работает с тем же pid, ошибка
// словом в keeper.state, part.failed в журнал флота; другие части плана исполняются; папки битой версии нет (чьё: код — «версия годна, когда
// стоит и её app.json разобран: только тогда прежняя останавливается»; ревью архитектора 1 нояб.).
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
	alien := appFiles("")
	alien["app.json"] = `{"run":["x"],"user":"admin"}`
	for i, c := range []struct {
		p    map[string]any
		word string
	}{{missing, "download_failed"}, {s.links.part("capture", "1.4.1", setup, on), "setup_failed"}, {foreign, "download_failed"}, {s.links.part("capture", "1.5.0", alien, on), "contract_mismatch"}} {
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
	for _, v := range []string{"1.4.0", "1.4.1", "1.4.2"} {
		if isThere(verDir(s.home, "capture", v)) {
			t.Fatalf("папка негодной версии %s осталась", v)
		}
	}
}

// 3162 · Скачивание не уложилось в предел — download_failed с причиной, прежняя работает, part.failed (слово пользователя 2 нояб.: «у всех
// операций должен быть лимит»).
func TestEtDownloadLimit(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.startWith(tuning{download: time.Second})
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

// Подмена себя: последним шагом плана, где бы ни стояла запись keeper; новый файл ответил своей версией → часть уже на новой версии, свой файл
// подменён, part.updated и выход; держатели живут; версии keeper на диске — новая и та, с которой ушли; занятое прежнее имя файла не мешает
// (план заморозки, «Подмена себя»: «По плану, последним шагом; держатели живут»; машины 1 нояб.: 6 версий, 77 МБ; ревью 1 нояб.: Access is
// denied на Windows).
func TestEtSelfUpdate(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "9.9.9")
	target := filepath.Join(t.TempDir(), binName("keeper"))
	os.WriteFile(target, []byte("old"), 0o755)
	busy := target + "." + ourVersion + ".old"
	os.WriteFile(busy, []byte("epoch 1"), 0o755)
	h, err := os.Open(busy)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for _, v := range []string{"0.0.1", ourVersion} {
		os.MkdirAll(verDir(s.home, "keeper", v), 0o700)
	}
	app := s.links.part("capture", "1.3.2", appFiles(""), on)
	kp := s.links.part("keeper", "9.9.9", files{archDir() + "/" + binName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, kp, app))
	k := s.startWith(tuning{self: func() (string, error) { return target, nil }})
	select {
	case <-k.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("keeper не подменил себя")
	}
	if b, _ := os.ReadFile(target); len(b) != len(bin) {
		t.Fatal("файл keeper не подменён")
	}
	if ms, _ := filepath.Glob(target + "." + ourVersion + ".*.old"); len(ms) != 1 {
		t.Fatalf("старый файл не переименован: %v", ms)
	}
	if f := heldFiles(s.home); len(f) != 1 || !alive(f[0].Pid) {
		t.Fatal("держатель приложения не пережил подмену keeper")
	}
	waitFor(t, "part.updated keeper", func() bool { return s.relay.ledgerHas("part.updated keeper " + ourVersion + " → 9.9.9") })
	j := readJournal(s.home)
	if !strings.Contains(j, `"ev":"self_update","from":"`+ourVersion+`","to":"9.9.9","why":"файл подменён — выход, ОС поднимет новый"`) {
		t.Fatal("нет строки self_update с причиной")
	}
	if a, b := strings.Index(j, `"ev":"part_start","version":"1.3.2"`), strings.Index(j, `"ev":"self_update"`); a < 0 || b < 0 || a > b {
		t.Fatalf("порядок: part_start capture %d, self_update %d", a, b)
	}
	es, _ := os.ReadDir(partFolder(s.home, "keeper"))
	var got []string
	for _, e := range es {
		got = append(got, e.Name())
	}
	if strings.Join(got, " ") != ourVersion+" 9.9.9" {
		t.Fatalf("версии keeper: %v", got)
	}
}

// Новый файл keeper не тот: check_failed в журнале машины и флота, keeper не выходит; следующий план с той же записью пробует подмену снова
// (чьё: код — решение архитектора 2 нояб.: повтор с диска дешёвый, каждый сбой в журнале флота).
func TestEtSelfCheckFailedRepeats(t *testing.T) {
	s := newStand(t)
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	t.Setenv("KEEPER_TEST_VERSION", "1.0.0")
	kp := s.links.part("keeper", "9.9.9", files{archDir() + "/" + binName("keeper"): string(bin)}, nil)
	s.relay.setPlan(plan1(1, kp))
	k := s.start()
	waitFor(t, "check_failed", func() bool { return strings.Contains(partOf(k, "keeper").Error, "check_failed") })
	waitFor(t, "keeper на связи", func() bool { return s.relay.planAsks() > 0 })
	if !journalHas(s.home, `"ev":"part_failed","why":"keeper 9.9.9: check_failed: новый файл ответил «1.0.0» (<nil>), а в плане 9.9.9"`) {
		t.Fatal("сбой подмены не в журнале машины")
	}
	s.relay.push(planMsg(2, kp, s.links.part("capture", "1.3.2", appFiles(""), on)))
	waitFor(t, "второй сбой", func() bool { return s.relay.ledgerCount("part.failed keeper 9.9.9 — check_failed") == 2 })
	select {
	case <-k.Done():
		t.Fatal("keeper остановился после check_failed")
	default:
	}
}

// Ничей держатель keeper на старте снят: процесс жив или уже вышел — orphan_kill, файл убран, держатель вышел, held_unclaimed нет, part_start нет
// (чьё: код — «Есть в плане — подключиться, нет — убить»; устав: «Keeper без решений… исполняет план»).
func TestEtOrphanHolder(t *testing.T) {
	for _, exited := range []bool{false, true} {
		s := newStand(t)
		self, _ := os.Executable()
		f, err := holdProc(s.home, holdReq{ID: "old", Owner: "keeper", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=10s"), Cmd: []string{self, "app"}})
		if err != nil {
			t.Fatal(err)
		}
		var hf heldFile
		b, _ := os.ReadFile(heldPath(s.home, "old"))
		json.Unmarshal(b, &hf)
		if exited {
			killPid(t, f.Pid)
			waitFor(t, "процесс вышел", func() bool { return !alive(f.Pid) })
		}
		s.relay.setPlan(plan1(1))
		s.start()
		waitFor(t, "держатель вышел", func() bool { return !isThere(heldPath(s.home, "old")) && !alive(hf.Holder) && !alive(f.Pid) })
		if !journalHas(s.home, `"ev":"orphan_kill","id":"old"`) || journalHas(s.home, `"ev":"held_unclaimed"`) || journalHas(s.home, `"ev":"part_start","part":"old"`) {
			t.Fatal("ничей держатель снят не так")
		}
	}
}

// Держатели Host keeper не трогает: ни подключения, ни снятия; вышедший такой держатель уходит сам по пределу ожидания хозяина (устав: «Keeper
// без решений. Процессы claude держит Host через свои держатели»; ubuntu-db 3 нояб.).
func TestEtHostHoldersUntouched(t *testing.T) {
	for _, exited := range []bool{false, true} {
		s := newStand(t)
		self, _ := os.Executable()
		f, err := holdProc(s.home, holdReq{ID: "site@win", Owner: "host", Env: append(os.Environ(), "KEEPER_TEST_OWNER_WAIT=1s"), Cmd: []string{self, "app"}})
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
				return journalHas(s.home, `"ev":"held_unclaimed","callsign":"site@win"`) && !isThere(heldPath(s.home, "site@win"))
			})
		} else {
			time.Sleep(700 * time.Millisecond)
			if !isThere(heldPath(s.home, "site@win")) || !alive(f.Pid) {
				t.Fatal("держатель Host тронут")
			}
		}
		if journalHas(s.home, `"ev":"adopt","id":"site@win"`) || journalHas(s.home, `"ev":"orphan_kill","id":"site@win"`) {
			t.Fatal("keeper взялся за держатель Host")
		}
	}
}

// 3171 · Битый plan.json — строка stop с причиной, держатели частей сняты как ничьи, keeper живёт и поднимает части по плану «выпусков» заново.
func TestEtBrokenPlanOrphans(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	k.Stop()
	os.WriteFile(planFile(s.home), []byte("{битый"), 0o600)
	k2 := s.start()
	if r := journalLine(s.home, `"ev":"plan","why":"plan.json`); r == nil || r["kind"] != "stop" {
		t.Fatalf("строка о битом plan.json: %v", r)
	}
	waitFor(t, "часть поднята заново", func() bool { p := partOf(k2, "capture"); return p.State == "running" && p.Pid != pid })
	if !journalHas(s.home, `"ev":"orphan_kill","id":"capture"`) {
		t.Fatal("держатель части не снят как ничей")
	}
}

// 3172 · keeper.json не прочитан — старт отказан: код 1, «keeper: …» в stderr, строка stop keeper_start с причиной; держатели частей не тронуты
// (устав: система ловит — «останавливает, отказывает, пишет в журнал с причиной»).
func TestEtBadConfRefused(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	k.Stop()
	os.WriteFile(confFile(s.home), []byte("{битый"), 0o600)
	code, _, stderr := runKeeper(t, s.home, "", "run")
	if code != 1 || !strings.Contains("\n"+stderr, "\nkeeper: ") || !alive(pid) {
		t.Fatalf("код %d, stderr %q, часть жива %v", code, stderr, alive(pid))
	}
	if r := journalLine(s.home, `"ev":"keeper_start","why"`); r == nil || r["kind"] != "stop" || !strings.HasPrefix(fmt.Sprint(r["why"]), "keeper.json не прочитан: ") {
		t.Fatalf("строка keeper_start %v", r)
	}
}

// 5081 · 5082 · Обрыв связи с relay — keeper переподключается к relay своей машины (/m/<машина> из пропуска) тем же hello и спрашивает план снова
// POST «Выпускам» пропуском машины; тот же план, в том числе кадром, части не трогает: pid тот же, строк plan нет (устав, закрытый список:
// «соединение… оборвалось — клиенты переподключаются»; дизайн «Открытый флот»; чьё: код — «Та же rev — переподключение»).
func TestEtRelayDropReasks(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	pid := partOf(k, "capture").Pid
	s.relay.drop()
	waitFor(t, "вопрос после переподключения", func() bool { return s.relay.planAsks() == 2 })
	time.Sleep(500 * time.Millisecond)
	s.relay.push(planMsg(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	time.Sleep(500 * time.Millisecond)
	hello, opens := s.relay.seen()
	if opens != 2 || hello["key"] != "host.win.ab12.sig" || hello["proto"] != float64(1) || hello["part"] != "keeper" {
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
	j := readJournal(s.home)
	if strings.Count(j, `"ev":"plan","rev":1`) != 1 || strings.Contains(j, `"word":"old_rev"`) ||
		strings.Count(j, `"ev":"relay_open"`) != 2 || !strings.Contains(j, `"ev":"relay_closed"`) {
		t.Fatal("строки журнала о переподключении: нужны relay_open ×2, relay_closed, одна строка plan, без old_rev")
	}
}

// Команды run нет на машине — держатель не запустил её: часть failed с причиной «запуск: держатель не запустился: …», part.failed в журнале флота,
// в журнале машины hold_failed с причиной, файла о держателе нет (устав: система ловит).
func TestEtRunFailsToStart(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.0.0", files{"app.json": `{"run":["switchboard-no-such-program"]}`}, on)))
	k := s.start()
	waitFor(t, "failed", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.HasPrefix(p.Error, "запуск: держатель не запустился")
	})
	waitFor(t, "part.failed", func() bool { return s.relay.ledgerHas("part.failed capture 1.0.0 — запуск: ") })
	if r := journalLine(s.home, `"ev":"hold_failed"`); r == nil || r["kind"] != "stop" || r["why"] == "" || r["why"] == nil {
		t.Fatalf("строка hold_failed %v", r)
	}
	if isThere(heldPath(s.home, "capture")) {
		t.Fatal("файл держателя остался")
	}
}

// 5510 · Держатель не прислал строку о себе за предел — запуск части отказан «держатель не ответил за …», держатель убит, файла о нём нет (устав:
// «у всех операций лимит», слово пользователя 2 нояб.).
func TestEtHolderSilentOnSpawn(t *testing.T) {
	s := newStand(t)
	s.relay.setPlan(plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on)))
	t.Setenv("KEEPER_TEST_HOLD_SILENT", "1")
	k := s.startWith(tuning{holderWait: 500 * time.Millisecond})
	waitFor(t, "failed", func() bool {
		p := partOf(k, "capture")
		return p.State == "failed" && strings.Contains(p.Error, "держатель не ответил за 500ms")
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

// node из app.json — Node из keeper.json; npm — npm-cli.js рядом с ним под тем же Node: на Windows npm — это npm.cmd, а у службы может не быть PATH;
// путь, который есть в папке версии, — полный (чьё: дизайн «npm — npm рядом с ним»).
func TestEtNodeAndNpmFromConf(t *testing.T) {
	s := newStand(t)
	d := t.TempDir()
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	node := filepath.Join(d, binName("node"))
	os.WriteFile(node, bin, 0o755)
	cli := filepath.Join(d, "node_modules", "npm", "bin", "npm-cli.js")
	os.MkdirAll(filepath.Dir(cli), 0o755)
	os.WriteFile(cli, nil, 0o644)
	saveConf(s.home, map[string]any{"node": node, "workers": map[string]any{"relay": "http" + strings.TrimPrefix(s.relay.url(), "ws"), "releases": s.relay.workerURL("releases"), "ledger": s.relay.workerURL("ledger")}})
	t.Setenv("KEEPER_TEST_NODE", filepath.Join(d, "calls"))
	s.relay.setPlan(plan1(1, s.links.part("web", "1.0.0", files{"app.json": `{"run":["node","main.cjs","x"],"setup":["npm","ci","--omit=dev"]}`, "main.cjs": "//"}, on)))
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "web").State == "running" })
	dir := verDir(s.home, "web", "1.0.0")
	waitFor(t, "оба вызова", func() bool {
		b, _ := os.ReadFile(filepath.Join(d, "calls"))
		return strings.Count(string(b), "\n") == 2
	})
	b, _ := os.ReadFile(filepath.Join(d, "calls"))
	want := cli + "|ci|--omit=dev\n" + filepath.Join(dir, "main.cjs") + "|x\n"
	if string(b) != want {
		t.Fatalf("вызовы %q, а надо %q", b, want)
	}
}

// Связь с relay: недоступен — keeper повторяет подключение с паузой от первой вдвое до предела; принял hello, но на ping молчит — соединение мёртвое:
// закрывает и подключается снова, пауза после принятого hello снова первая (устав, закрытый список: «соединение… оборвалось — клиенты
// переподключаются»; факт: сеть WSL теряет пакеты; чьё: код — «нет pong к следующему — соединение мёртвое», «от 1 с, вдвое до 60 с»).
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
	home := relayHome(t, srv.URL)
	k := bootOn(t, home, tuning{ping: 100 * time.Millisecond, pauseFirst: 50 * time.Millisecond, pauseMax: time.Second})
	_ = k
	waitFor(t, "второе подключение после молчания на ping", func() bool { mu.Lock(); defer mu.Unlock(); return hellos >= 2 })
	mu.Lock()
	defer mu.Unlock()
	if n := strings.Count(readJournal(home), `"ev":"relay_closed","why":"dial: `); n < 4 {
		t.Fatalf("неудачных подключений %d", n)
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

// relay не принял hello — причина в журнале, вопроса о плане нет, паузы растут и не сбрасываются (устав: система ловит; чьё: код — «roster — знак,
// что hello принят», пауза сбрасывается только после принятого hello).
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
	home := relayHome(t, srv.URL)
	bootOn(t, home, tuning{pauseFirst: 50 * time.Millisecond, pauseMax: time.Second})
	waitFor(t, "пять попыток", func() bool { mu.Lock(); defer mu.Unlock(); return len(at) >= 5 })
	mu.Lock()
	defer mu.Unlock()
	j := readJournal(home)
	if strings.Contains(j, `"ev":"relay_open"`) || !strings.Contains(j, "bad_key") {
		t.Fatalf("журнал %s", j)
	}
	for i, min := range []time.Duration{50, 100, 200, 400} {
		if gap := at[i+1].Sub(at[i]); gap < min*time.Millisecond {
			t.Fatalf("пауза после отказа %d — %v, меньше %v мс: сброшена без принятого hello", i+1, gap, min)
		}
	}
}

// 5084 · Установка: приглашение машины — первой строкой stdin; keeper принимает его POST gate.redeem и кладёт пропуск в machine.key; keeper.json —
// node из PATH полным путём, relay и Worker'ы из флагов, незнакомые поля целы; файл keeper — на постоянном месте (дизайн «Открытый флот»; устав:
// секреты через stdin; conf.go «Незнакомые поля сохраняются как есть»).
func TestEtInstallConf(t *testing.T) {
	r := newFakeRelay(t)
	home := t.TempDir()
	t.Setenv("SWITCHBOARD_HOME", home)
	bin := t.TempDir()
	node := filepath.Join(bin, binName("node"))
	os.WriteFile(node, []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", bin)
	saveConf(home, map[string]any{"site": "lab"})
	dst, err := prepareMachine([]string{"--worker", "relay=https://relay.test/", "--worker", "gate=" + r.workerURL("gate"), "--worker", "releases=https://releases.test/", "--worker", "ledger=https://ledger.test/"}, bufio.NewReader(strings.NewReader("win1.INVITE\r\npassword\n")))
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "machine.key")); string(b) != "host.win.win1.SECRET\n" {
		t.Fatalf("machine.key %q", b)
	}
	m, _ := loadConf(home)
	w := confWorkers(m)
	if m["node"] != node || m["relay"] != nil || w["relay"] != "https://relay.test/" || m["site"] != "lab" || w["releases"] != "https://releases.test/" || w["ledger"] != "https://ledger.test/" {
		t.Fatalf("keeper.json %v", m)
	}
	self, _ := os.Executable()
	a, _ := os.Stat(self)
	b, _ := os.Stat(dst)
	if dst != filepath.Join(home, binName("keeper")) || b == nil || a.Size() != b.Size() {
		t.Fatalf("файл keeper %q", dst)
	}
}

// 5084 · Погашенное приглашение, приглашение не машины, нет адреса gate или пустой stdin — отказ словами, machine.key не тронут (устав: система
// ловит — отказывает).
func TestEtInstallKeyRefused(t *testing.T) {
	r := newFakeRelay(t)
	cases := []struct {
		in, gate, word string
	}{
		{"used.INVITE\n", r.workerURL("gate"), "приглашение не принято: bad_invite"},
		{"phn1.INVITE\n", r.workerURL("gate"), "приглашение не машины: пропуск client.phone.phn1"},
		{"win1.INVITE\n", "", "нет адреса gate: --worker gate=https://…"},
		{"", r.workerURL("gate"), "приглашение машины — первой строкой stdin: нет строки в stdin: "},
	}
	for _, c := range cases {
		home := t.TempDir()
		t.Setenv("SWITCHBOARD_HOME", home)
		saveConf(home, map[string]any{"node": "/x/node"})
		os.WriteFile(filepath.Join(home, "machine.key"), []byte("host.win.old1.OLD\n"), 0o600)
		args := []string{}
		if c.gate != "" {
			args = append(args, "--worker", "gate="+c.gate)
		}
		_, err := prepareMachine(args, bufio.NewReader(strings.NewReader(c.in)))
		if b, _ := os.ReadFile(filepath.Join(home, "machine.key")); err == nil || !strings.Contains(err.Error(), c.word) || string(b) != "host.win.old1.OLD\n" {
			t.Fatalf("stdin %q: %v, machine.key %q", c.in, err, b)
		}
	}
}

// 5521 · 5561 · install --name prod: служба switchboard-keeper-prod, папка ~/.switchboard-prod, команда службы run --name prod; пропуск, keeper.json и файл
// keeper — в своей папке, файл первого флота не заменён (дизайн «Любой агент», этап 0: «keeper обновляет файл в своей папке»).
func TestEtNameInstallOwnFolder(t *testing.T) {
	u := nameStand(t)
	first := filepath.Join(u, ".switchboard", binName("keeper"))
	os.MkdirAll(filepath.Dir(first), 0o700)
	os.WriteFile(first, []byte("первый флот"), 0o755)
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"type": "reply", "id": "install", "ok": true, "result": map[string]string{"key": "host.pc.ab12.sig"}})
	}))
	defer gate.Close()
	rest, err := chooseFleet([]string{"--name", "prod", "--worker", "gate=" + gate.URL})
	if err != nil {
		t.Fatal(err)
	}
	if fleetService() != "switchboard-keeper-prod" || !reflect.DeepEqual(fleetCommand(), []string{"run", "--name", "prod"}) {
		t.Fatalf("служба %q, команда %v", fleetService(), fleetCommand())
	}
	home, _ := fleetHome()
	if want := filepath.Join(u, ".switchboard-prod"); home != want {
		t.Fatalf("папка %q, а надо %q", home, want)
	}
	saveConf(home, map[string]any{"node": "/x/node"})
	dst, err := prepareMachine(rest, bufio.NewReader(strings.NewReader("invite\n")))
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "machine.key")); strings.TrimSpace(string(b)) != "host.pc.ab12.sig" {
		t.Fatalf("machine.key %q", b)
	}
	if want := filepath.Join(u, ".switchboard-prod", binName("keeper")); dst != want {
		t.Fatalf("файл %q, а надо %q", dst, want)
	}
	if got, _ := os.ReadFile(first); string(got) != "первый флот" {
		t.Fatalf("файл первого флота заменён: %d байт", len(got))
	}
}

// 5523 · 5567 · keeper run --name работает в своей папке; под именем умер — та же команда подключается к держателям своей папки; второй keeper этого не
// замечает (устав, закрытый список: «keeper умер… ОС поднимает его, держатели живут, keeper подключается к своим»; дизайн этапа 0 «ничего не знает о второй»).
func TestEtNameAdoptOwnHolders(t *testing.T) {
	u := nameStand(t)
	a := newNamedKeeper(t, u, "a")
	b := newNamedKeeper(t, u, "b")
	pidA, pidB := a.partPid(), b.partPid()
	if pidA == pidB {
		t.Fatalf("одна часть на двоих: pid %d", pidA)
	}
	a.kill()
	if !alive(pidA) {
		t.Fatal("часть a умерла вместе с keeper")
	}
	a.run()
	waitFor(t, "adopt своей части", func() bool { return journalHas(a.own, fmt.Sprintf(`"ev":"adopt","id":"capture","pid":%d`, pidA)) })
	if n := strings.Count(journalText(a.own), `"ev":"part_start"`); n != 1 {
		t.Fatalf("часть a запущена %d раз", n)
	}
	if journalHas(b.own, `"ev":"adopt"`) || strings.Count(journalText(b.own), `"ev":"part_start"`) != 1 || !alive(pidB) || b.cmd.ProcessState != nil {
		t.Fatalf("второй keeper задет: %s", journalText(b.own))
	}
	if _, err := os.Stat(filepath.Join(u, ".switchboard")); !os.IsNotExist(err) {
		t.Fatalf("прежняя папка появилась: %v", err)
	}
}

// Адреса «Выпусков» и журнала нет в keeper.json — строки с причиной, сохранённый план исполняется (устав: система ловит — пишет с причиной).
func TestEtNoWorkerAddress(t *testing.T) {
	s := newStand(t)
	saveConf(s.home, map[string]any{"workers": map[string]any{"relay": "http" + strings.TrimPrefix(s.relay.url(), "ws")}})
	p := plan1(1, s.links.part("capture", "1.3.2", appFiles(""), on))
	b, _ := json.Marshal(p)
	os.WriteFile(planFile(s.home), b, 0o600)
	k := s.start()
	waitFor(t, "running", func() bool { return partOf(k, "capture").State == "running" })
	waitFor(t, "строка о «Выпусках»", func() bool {
		return journalHas(s.home, "в keeper.json нет адреса «Выпусков» (workers.releases) — исполняю сохранённый план")
	})
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "перезапуск", func() bool { p := partOf(k, "capture"); return p.State == "running" && p.Restarts == 1 })
	killPid(t, partOf(k, "capture").Pid)
	waitFor(t, "строка о журнале", func() bool {
		return journalHas(s.home, "нет адреса журнала (workers.ledger): capture 1.3.2 — второе падение: ")
	})
}
