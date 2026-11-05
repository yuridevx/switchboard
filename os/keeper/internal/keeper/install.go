package keeper

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"switchboard/keeper/internal/holder"
	"switchboard/keeper/internal/machine"
)

const (
	stampName = "release.sha256"
	selfName  = "keeper"
	waitDelay = 5 * time.Second // команда вышла или убита, а потомок держит её вывод
)

func must(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// app — app.json версии: команда запуска, подготовка после распаковки, дети вне задания держателя.
type app struct {
	Run            []string `json:"run"`
	Setup          []string `json:"setup"`
	DetachChildren bool     `json:"detach_children"`
}

// install — версия годна: стоит из этого архива, app.json разобран, setup прошёл.
func (k *Keeper) install(e Entry) (app, error) {
	err := k.ensure(e, func(dir string) error {
		a, err := readApp(dir)
		if err != nil {
			return err
		}
		return k.setup(a, dir)
	})
	if err != nil {
		return app{}, err
	}
	return readApp(filepath.Join(k.partDir(e.Part), e.Version))
}

// ensure — папка версии: готовая — с меткой хэша архива, тогда без скачивания; иначе скачать, сверить, распаковать, ready, отметить. Сбой — папки нет.
// Распаковка — сразу в папку версии: готовой её делает метка, а npm на Windows связывает пакеты ссылками с полным путём, переименовать папку после него нельзя.
func (k *Keeper) ensure(e Entry, ready func(dir string) error) error {
	if !machine.ValidName(e.Part) || !machine.ValidName(e.Version) {
		return fmt.Errorf("bad_plan: часть «%s» версия «%s»", e.Part, e.Version)
	}
	dir := filepath.Join(k.partDir(e.Part), e.Version)
	stamp := filepath.Join(dir, stampName)
	if b, err := os.ReadFile(stamp); err == nil && strings.TrimSpace(string(b)) == e.SHA256 {
		return nil
	}
	body, err := k.download(e)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("download_failed: %w", err)
	}
	if err := unpack(body, dir); err != nil {
		os.RemoveAll(dir)
		return fmt.Errorf("download_failed: распаковка: %w", err)
	}
	if ready != nil {
		if err := ready(dir); err != nil {
			os.RemoveAll(dir)
			return err
		}
	}
	if err := os.WriteFile(stamp, []byte(e.SHA256+"\n"), 0o600); err != nil {
		os.RemoveAll(dir)
		return fmt.Errorf("download_failed: %w", err)
	}
	k.note(e.Part, "installed", "version", e.Version, "bytes", len(body))
	return nil
}

// download — архив по ссылке из плана, предел — у клиента, отмена — остановка keeper. В ошибках нет адреса: в нём подпись ссылки, а ошибка идёт в журнал флота.
func (k *Keeper) download(e Entry) ([]byte, error) {
	if e.URL == "" {
		return nil, fmt.Errorf("download_failed: %s %s нет на диске и нет ссылки", e.Part, e.Version)
	}
	refused := func(err error) ([]byte, error) {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("download_failed: GET %s %s: %w", e.Part, e.Version, err)
	}
	req, err := http.NewRequestWithContext(k.ctx, http.MethodGet, e.URL, nil)
	if err != nil {
		return refused(err)
	}
	res, err := (&http.Client{Timeout: k.o.Download}).Do(req)
	if err != nil {
		return refused(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return refused(fmt.Errorf("%d", res.StatusCode))
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return refused(err)
	}
	sum := sha256.Sum256(body)
	if got := hex.EncodeToString(sum[:]); got != e.SHA256 {
		return nil, fmt.Errorf("download_failed: sha256 %s %s — %s, а в плане %s", e.Part, e.Version, got, e.SHA256)
	}
	return body, nil
}

// unpack — tgz в папку: пути только внутрь неё, записи — только файлы и папки.
func unpack(b []byte, dir string) error {
	gz, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil && !errors.Is(err, tar.ErrInsecurePath) {
			return err
		}
		name := filepath.FromSlash(h.Name)
		if !filepath.IsLocal(name) {
			return fmt.Errorf("путь вне папки: %s", h.Name)
		}
		path := filepath.Join(dir, name)
		switch h.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(path, 0o755)
		case tar.TypeReg:
			err = writeFile(path, h, tr)
		default:
			err = fmt.Errorf("запись %s вида %q — в архиве части только файлы и папки", h.Name, h.Typeflag)
		}
		if err != nil {
			return err
		}
	}
}

func writeFile(path string, h *tar.Header, r io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if h.Mode&0o111 != 0 {
		mode = 0o755
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, r)
	return err
}

func readApp(dir string) (app, error) {
	var a app
	b, err := os.ReadFile(filepath.Join(dir, "app.json"))
	if err != nil {
		return a, fmt.Errorf("no_app_json: %w", err)
	}
	if err := strict(b, &a); err != nil {
		return a, fmt.Errorf("contract_mismatch: app.json: %w", err)
	}
	if len(a.Run) == 0 {
		return a, errors.New("app.json без run")
	}
	return a, nil
}

// setup — в папке версии, с пределом. Остановка keeper начатый setup доводит: следующему keeper не качать архив, ссылка на который могла истечь.
func (k *Keeper) setup(a app, dir string) error {
	if len(a.Setup) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.o.StopLimit)
	defer cancel()
	argv := k.command(dir, a.Setup)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	holder.Prepare(cmd)
	cmd.Dir, cmd.WaitDelay = dir, waitDelay
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return fmt.Errorf("setup_failed: не завершился за %v", k.o.StopLimit)
	}
	if err != nil {
		s := strings.TrimSpace(string(out))
		return fmt.Errorf("setup_failed: %v: %s", err, s[max(0, len(s)-2000):])
	}
	return nil
}

// command — run или setup из app.json: node — Node из keeper.json, npm — npm-cli.js рядом с ним под тем же Node (на Windows npm — это npm.cmd, а у службы
// может не быть PATH); пути — от папки версии.
func (k *Keeper) command(dir string, argv []string) []string {
	out := make([]string, 0, len(argv)+1)
	for i, a := range argv {
		switch cli := npmCli(k.conf.Node); {
		case i == 0 && a == "node" && k.conf.Node != "":
			out = append(out, k.conf.Node)
		case i == 0 && a == "npm" && cli != "":
			out = append(out, k.conf.Node, cli)
		case filepath.IsLocal(a) && exists(filepath.Join(dir, a)):
			out = append(out, filepath.Join(dir, a))
		default:
			out = append(out, a)
		}
	}
	return out
}

// npmCli — npm-cli.js рядом с Node: Windows — <папка node>/node_modules/npm, Linux — <папка node>/../lib/node_modules/npm.
func npmCli(node string) string {
	if node == "" {
		return ""
	}
	d := filepath.Dir(node)
	for _, p := range []string{filepath.Join(d, "node_modules", "npm", "bin", "npm-cli.js"), filepath.Join(d, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")} {
		if exists(p) {
			return p
		}
	}
	return ""
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// cleanOldSelf — прежние файлы keeper; занятые держателями остаются до следующего старта.
func (k *Keeper) cleanOldSelf() {
	self, err := k.o.Self()
	if err != nil {
		return
	}
	olds, _ := filepath.Glob(self + ".*.old")
	for _, o := range olds {
		os.Remove(o)
	}
}

// updateSelf — запись keeper. Та же версия, что работает, — делать нечего, прежний сбой подмены больше не в силе. Иначе подменить свой файл и выйти: ОС поднимет
// новый, он подключится к держателям. Сбой — keeper failed, как у любой части, и работает дальше.
func (k *Keeper) updateSelf(e Entry) {
	if e.Version == k.o.Version {
		k.mu.Lock()
		delete(k.parts, selfName)
		k.mu.Unlock()
		return
	}
	err := k.replaceSelf(e)
	if k.leaving() {
		return
	}
	if err != nil {
		k.fail(k.slot(selfName), e.Version, err.Error())
		return
	}
	// свои папки версий — новая и та, с которой уходим: прежний файл для отката лежит рядом
	k.dropVersions(selfName, e.Version, k.o.Version)
	k.note("keeper", "self_update", "from", k.o.Version, "to", e.Version, "why", "файл подменён — выход, ОС поднимет новый")
	k.ledger("part.updated", fmt.Sprintf("%s %s → %s", selfName, k.o.Version, e.Version))
	k.cancel()
}

// replaceSelf — скачать, спросить у нового файла его версию, подменить свой.
func (k *Keeper) replaceSelf(e Entry) error {
	if err := k.ensure(e, nil); err != nil {
		return err
	}
	name := selfName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	file := filepath.Join(k.partDir(selfName), e.Version, runtime.GOOS+"-"+runtime.GOARCH, name)
	ctx, cancel := context.WithTimeout(k.ctx, k.o.StopLimit)
	defer cancel()
	cmd := exec.CommandContext(ctx, file, "version")
	holder.Prepare(cmd)
	cmd.WaitDelay = waitDelay
	out, err := cmd.Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("check_failed: новый файл не ответил за %v", k.o.StopLimit)
	}
	if got := strings.TrimSpace(string(out)); err != nil || got != e.Version {
		return fmt.Errorf("check_failed: новый файл ответил «%s» (%v), а в плане %s", got, err, e.Version)
	}
	target, err := k.o.Self()
	if err != nil {
		return err
	}
	// прежний файл держат держатели, пока живы, — иногда днями: имя у него каждый раз новое
	if err := machine.Swap(file, target, fmt.Sprintf("%s.%s.%d.old", target, k.o.Version, os.Getpid())); err != nil {
		return fmt.Errorf("подмена: %w", err)
	}
	return nil
}
