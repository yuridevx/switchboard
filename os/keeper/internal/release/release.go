// Package release — версия части на диске: скачать архив по ссылке из плана, сверить sha256, распаковать, выполнить setup из app.json, отметить папку
// хэшем архива. Готовая версия — папка с меткой. Подмена файла keeper — та же запись: копия рядом и rename.
package release

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
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"switchboard/keeper/internal/holder"
	"switchboard/keeper/internal/journal"
	"switchboard/keeper/internal/machine"
)

// App — app.json части: команда запуска, подготовка после распаковки, дети вне задания держателя.
type App struct {
	Run            []string `json:"run"`
	Setup          []string `json:"setup"`
	DetachChildren bool     `json:"detach_children"`
}

// Strict — разбор контракта v1: незнакомое поле — ошибка, замороженный keeper не исполняет того, чего не знает.
func Strict(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	return d.Decode(v)
}

// ReadApp — app.json папки версии.
func ReadApp(dir string) (App, error) {
	var a App
	b, err := os.ReadFile(filepath.Join(dir, "app.json"))
	if err != nil {
		return a, fmt.Errorf("no_app_json: %v", err)
	}
	if err := Strict(b, &a); err != nil {
		return a, fmt.Errorf("contract_mismatch: app.json: %v", err)
	}
	if len(a.Run) == 0 {
		return a, errors.New("app.json без run")
	}
	return a, nil
}

// Source — откуда версия.
type Source struct{ Part, Version, Sha256, URL string }

// Installer — установка версий на этой машине.
type Installer struct {
	Home, Node string
	Client     *http.Client  // предел скачивания — у него
	SetupLimit time.Duration // предел setup
	J          *journal.Journal
}

func stamp(dir string) string { return filepath.Join(dir, "release.sha256") }

// Install — папка версии; уже стоит из того же архива — без скачивания. Отмена ctx прерывает скачивание: остановка keeper его не ждёт; начатый setup доводится.
func (in *Installer) Install(ctx context.Context, s Source) (string, error) {
	if !machine.ValidName(s.Part) || !machine.ValidName(s.Version) {
		return "", fmt.Errorf("bad_plan: часть «%s» версия «%s»", s.Part, s.Version)
	}
	dir := machine.VersionDir(in.Home, s.Part, s.Version)
	if b, err := os.ReadFile(stamp(dir)); err == nil && strings.TrimSpace(string(b)) == s.Sha256 {
		return dir, nil
	}
	body, err := in.download(ctx, s)
	if err != nil {
		return "", err
	}
	tmp := dir + ".tmp"
	os.RemoveAll(tmp)
	if err := untar(body, tmp); err != nil {
		os.RemoveAll(tmp)
		return "", fmt.Errorf("download_failed: распаковка: %v", err)
	}
	os.RemoveAll(dir)
	if err := os.Rename(tmp, dir); err != nil {
		os.RemoveAll(tmp)
		return "", err
	}
	// setup — уже в папке версии: npm на Windows связывает пакеты workspaces ссылками с полным путём, после переименования папки они вели бы в никуда
	if a, err := ReadApp(dir); err == nil && len(a.Setup) > 0 {
		if err := in.setup(a.Setup, dir); err != nil {
			os.RemoveAll(dir)
			return "", err
		}
	}
	if err := os.WriteFile(stamp(dir), []byte(s.Sha256+"\n"), 0o600); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	in.J.For(s.Part).Note("installed", "version", s.Version, "bytes", len(body))
	return dir, nil
}

func (in *Installer) download(ctx context.Context, s Source) ([]byte, error) {
	if s.URL == "" {
		return nil, fmt.Errorf("download_failed: %s %s нет на диске и нет ссылки", s.Part, s.Version)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.URL, nil)
	if err != nil {
		return nil, fmt.Errorf("download_failed: %v", err)
	}
	resp, err := in.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download_failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download_failed: GET %s %s: %d", s.Part, s.Version, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("download_failed: %v", err)
	}
	sum := sha256.Sum256(body)
	if got := hex.EncodeToString(sum[:]); got != s.Sha256 {
		return nil, fmt.Errorf("download_failed: sha256 %s %s — %s, а в плане %s", s.Part, s.Version, got, s.Sha256)
	}
	return body, nil
}

func (in *Installer) setup(command []string, dir string) error {
	c := in.Command(command, dir)
	ctx, cancel := context.WithTimeout(context.Background(), in.SetupLimit)
	defer cancel()
	cmd := exec.CommandContext(ctx, c[0], c[1:]...)
	// потомки setup держат трубу вывода — после убийства не ждать их дольше
	cmd.WaitDelay = 5 * time.Second
	cmd.Dir = dir
	holder.SetProcAttr(cmd)
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		err = fmt.Errorf("не завершился за %v", in.SetupLimit)
	}
	if err != nil {
		s := strings.TrimSpace(string(out))
		return fmt.Errorf("setup_failed: %v: %s", err, s[max(0, len(s)-2000):])
	}
	return nil
}

// Command — run или setup из app.json: node — Node из keeper.json, npm — npm-cli.js рядом с ним под тем же Node (на Windows npm — это npm.cmd, а у службы
// может не быть PATH); пути — от папки версии.
func (in *Installer) Command(run []string, dir string) []string {
	out := make([]string, 0, len(run)+1)
	for i, a := range run {
		switch {
		case i == 0 && a == "node" && in.Node != "":
			out = append(out, in.Node)
		case i == 0 && a == "npm" && npmCli(in.Node) != "":
			out = append(out, in.Node, npmCli(in.Node))
		case !filepath.IsAbs(a) && there(filepath.Join(dir, a)):
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
		if there(p) {
			return p
		}
	}
	return ""
}

func there(p string) bool { _, err := os.Stat(p); return err == nil }

// untar — tgz в папку; пути только внутрь неё, записи — только файлы и папки.
func untar(b []byte, dir string) error {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return err
	}
	tr := tar.NewReader(zr)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.FromSlash(h.Name)
		if name == "" || !filepath.IsLocal(name) {
			return fmt.Errorf("путь вне папки: %s", h.Name)
		}
		p := filepath.Join(dir, name)
		switch h.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(p, 0o755)
		case tar.TypeReg:
			err = writeEntry(p, h, tr)
		default:
			err = fmt.Errorf("запись %s вида %q — в архиве части только файлы и папки", h.Name, h.Typeflag)
		}
		if err != nil {
			return err
		}
	}
}

func writeEntry(p string, h *tar.Header, r io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if h.Mode&0o111 != 0 {
		mode = 0o755
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	f.Close()
	return err
}

// BinaryName — имя исполняемого файла этой ОС.
func BinaryName(s string) string {
	if runtime.GOOS == "windows" {
		return s + ".exe"
	}
	return s
}

// KeeperBinary — файл keeper этой ОС в папке версии: windows-amd64/keeper.exe, linux-amd64/keeper.
func KeeperBinary(dir string) string {
	return filepath.Join(dir, runtime.GOOS+"-"+runtime.GOARCH, BinaryName("keeper"))
}

// Replace — src на место dst целиком: копия рядом, прежний dst — в old (запущенный файл можно переименовать, но не удалить), копия — на место.
// Не вышло — dst прежний.
func Replace(src, dst, old string) error {
	tmp := dst + ".new"
	if err := copyFile(src, tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(dst, old); err != nil && !errors.Is(err, fs.ErrNotExist) {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Rename(old, dst)
		os.Remove(tmp)
		return err
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// CleanOld — прежние файлы keeper после подмены; занятые держателями остаются до следующего старта.
func CleanOld(self string) {
	ms, _ := filepath.Glob(self + ".*.old")
	for _, m := range ms {
		os.Remove(m)
	}
}
