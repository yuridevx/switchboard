package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// nameStand — домашняя папка пользователя в temp и прежние правила имени после эталона.
func nameStand(t *testing.T) string {
	t.Helper()
	u := t.TempDir()
	t.Setenv("HOME", u)
	t.Setenv("USERPROFILE", u)
	t.Setenv("SWITCHBOARD_HOME", "")
	s, f := serviceName, fleetName
	t.Cleanup(func() { serviceName, fleetName = s, f })
	return u
}

// 5521 · install --name prod: служба switchboard-keeper-prod, папка ~/.switchboard-prod, команда службы run --name prod;
// пропуск и keeper.json — в своей папке, флаги установки — как без имени (дизайн «Любой агент», этап 0).
func TestEtNameInstallOwnFolder(t *testing.T) {
	u := nameStand(t)
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"type": "reply", "id": "install", "ok": true, "result": map[string]string{"key": "host.pc.ab12.sig"}})
	}))
	defer gate.Close()
	rest, err := useName([]string{"--name", "prod", "--worker", "gate=" + gate.URL})
	if err != nil {
		t.Fatal(err)
	}
	if serviceName != "switchboard-keeper-prod" || !reflect.DeepEqual(runArgs(), []string{"run", "--name", "prod"}) {
		t.Fatalf("служба %q, команда %v", serviceName, runArgs())
	}
	home, _ := homeDir()
	if want := filepath.Join(u, ".switchboard-prod"); home != want {
		t.Fatalf("папка %q, а надо %q", home, want)
	}
	f, err := parseInstall(rest)
	if err != nil {
		t.Fatal(err)
	}
	if err := prepareConf(f, bufio.NewReader(strings.NewReader("invite\n"))); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "machine.key")); strings.TrimSpace(string(b)) != "host.pc.ab12.sig" {
		t.Fatalf("machine.key %q", b)
	}
	if _, err := os.Stat(filepath.Join(u, ".switchboard")); !os.IsNotExist(err) {
		t.Fatalf("чужая папка тронута: %v", err)
	}
}

// 5522 · Без имени — служба и папка прежние, команда run; имя с путём — отказ словом (дизайн этапа 0).
func TestEtNameAbsentSameAsBefore(t *testing.T) {
	u := nameStand(t)
	rest, err := useName([]string{"--hide"})
	if err != nil || !reflect.DeepEqual(rest, []string{"--hide"}) {
		t.Fatalf("%v %v", rest, err)
	}
	home, _ := homeDir()
	if serviceName != "switchboard-keeper" || home != filepath.Join(u, ".switchboard") || !reflect.DeepEqual(runArgs(), []string{"run"}) {
		t.Fatalf("служба %q, папка %q, команда %v", serviceName, home, runArgs())
	}
	for _, bad := range [][]string{{"--name"}, {"--name", "../x"}, {"--name", ""}} {
		if _, err := useName(bad); err == nil {
			t.Fatalf("%v без отказа", bad)
		}
	}
}

// 5523 · keeper run --name prod работает в своей папке (дизайн этапа 0); что часть получает её в SWITCHBOARD_HOME — TestEtPartEnv.
func TestEtNameRunOwnFolder(t *testing.T) {
	u := nameStand(t)
	own := filepath.Join(u, ".switchboard-prod")
	os.MkdirAll(own, 0o700)
	os.WriteFile(filepath.Join(own, "machine.key"), []byte("host.pc.ab12.sig\n"), 0o600)
	os.WriteFile(filepath.Join(own, "keeper.json"), []byte("{}\n"), 0o600)
	self, _ := os.Executable()
	cmd := exec.Command(self, "keeper", "run", "--name", "prod")
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	waitFor(t, "журнал в своей папке", func() bool {
		ms, _ := filepath.Glob(filepath.Join(own, "journal", "keeper-*.jsonl"))
		return len(ms) == 1
	})
	if _, err := os.Stat(filepath.Join(u, ".switchboard")); !os.IsNotExist(err) {
		t.Fatalf("прежняя папка появилась: %v", err)
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

// 5561 · Файл keeper — в своей папке: служба и задача запускают копию оттуда, файл первого флота не заменён
// (дизайн «Любой агент», этап 0: «keeper обновляет файл в своей папке»).
func TestEtNamePlaceSelfOwnFile(t *testing.T) {
	u := nameStand(t)
	first := filepath.Join(u, ".switchboard", exeName("keeper"))
	os.MkdirAll(filepath.Dir(first), 0o700)
	os.WriteFile(first, []byte("первый флот"), 0o755)
	if _, err := useName([]string{"--name", "prod"}); err != nil {
		t.Fatal(err)
	}
	home, _ := homeDir()
	os.MkdirAll(home, 0o700)
	dst, err := placeSelf()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(u, ".switchboard-prod", exeName("keeper")); dst != want {
		t.Fatalf("файл %q, а надо %q", dst, want)
	}
	self, _ := os.Executable()
	a, _ := os.Stat(self)
	b, err := os.Stat(dst)
	if err != nil || a.Size() != b.Size() {
		t.Fatalf("копия: %v, размер %d, а надо %d", err, b.Size(), a.Size())
	}
	if got, _ := os.ReadFile(first); string(got) != "первый флот" {
		t.Fatalf("файл первого флота заменён: %d байт", len(got))
	}
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
	waitFor(t, "файл держателя", func() bool { return len(readHoldFiles(home)) == 1 })
	c, _, err := dialHolder(readHoldFiles(home)[0])
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

// 5567 · keeper под именем умер — та же команда подключается к держателям своей папки; второй keeper этого не замечает
// (устав, закрытый список: «keeper умер… ОС поднимает его, держатели живут, keeper подключается к своим»; дизайн этапа 0
// «ничего не знает о второй»).
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
}
