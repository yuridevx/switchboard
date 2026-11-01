package main

// Установка версии части: скачать архив по ссылке из плана, сверить sha256, распаковать рядом,
// выполнить setup из app.json, отметить папку хэшем архива. Самообновление keeper — той же дорогой.
import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// app — app.json части: команда запуска, подготовка после распаковки, дети вне задания держателя.
type app struct {
	Run            []string `json:"run"`
	Setup          []string `json:"setup"`
	DetachChildren bool     `json:"detach_children"`
}

func partDir(home, name string) string         { return filepath.Join(home, "parts", name) }
func versionDir(home, name, v string) string    { return filepath.Join(partDir(home, name), v) }
func stampPath(dir string) string               { return filepath.Join(dir, "release.sha256") }

func readApp(dir string) (app, error) {
	var a app
	b, err := os.ReadFile(filepath.Join(dir, "app.json"))
	if err != nil {
		return a, fmt.Errorf("no_app_json: %v", err)
	}
	if err := json.Unmarshal(b, &a); err != nil {
		return a, fmt.Errorf("app.json: %v", err)
	}
	if len(a.Run) == 0 {
		return a, errors.New("app.json без run")
	}
	return a, nil
}

var httpClient = &http.Client{Timeout: 10 * time.Minute}

// install — папка версии части; уже стоит из того же архива — без скачивания.
func (k *Keeper) install(pp planPart) (string, error) {
	if !validID(pp.Part) || !validID(pp.Version) {
		return "", fmt.Errorf("bad_plan: часть «%s» версия «%s»", pp.Part, pp.Version)
	}
	dir := versionDir(k.home, pp.Part, pp.Version)
	if b, err := os.ReadFile(stampPath(dir)); err == nil && strings.TrimSpace(string(b)) == pp.Sha256 {
		return dir, nil
	}
	if pp.URL == "" {
		return "", fmt.Errorf("download_failed: %s %s нет на диске и нет ссылки", pp.Part, pp.Version)
	}
	resp, err := httpClient.Get(pp.URL)
	if err != nil {
		return "", fmt.Errorf("download_failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("download_failed: GET %s %s: %d", pp.Part, pp.Version, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("download_failed: %v", err)
	}
	sum := sha256.Sum256(body)
	if got := hex.EncodeToString(sum[:]); got != pp.Sha256 {
		return "", fmt.Errorf("download_failed: sha256 %s %s — %s, а в плане %s", pp.Part, pp.Version, got, pp.Sha256)
	}
	tmp := dir + ".tmp"
	os.RemoveAll(tmp)
	if err := untgz(body, tmp); err != nil {
		os.RemoveAll(tmp)
		return "", fmt.Errorf("download_failed: распаковка: %v", err)
	}
	if a, err := readApp(tmp); err == nil && len(a.Setup) > 0 {
		cmd := exec.Command(k.command(a.Setup, tmp)[0], k.command(a.Setup, tmp)[1:]...)
		cmd.Dir = tmp
		cmd.Env = os.Environ()
		setProcAttr(cmd)
		out, err := cmd.CombinedOutput()
		if err != nil {
			os.RemoveAll(tmp)
			s := strings.TrimSpace(string(out))
			if len(s) > 2000 {
				s = s[len(s)-2000:]
			}
			return "", fmt.Errorf("setup_failed: %v: %s", err, s)
		}
	}
	if err := os.WriteFile(stampPath(tmp), []byte(pp.Sha256+"\n"), 0o600); err != nil {
		os.RemoveAll(tmp)
		return "", err
	}
	os.RemoveAll(dir)
	if err := os.Rename(tmp, dir); err != nil {
		os.RemoveAll(tmp)
		return "", err
	}
	k.j.note("installed", "part", pp.Part, "version", pp.Version, "bytes", len(body))
	return dir, nil
}

// untgz — распаковать tgz в папку; пути только внутрь неё.
func untgz(b []byte, dir string) error {
	zr, err := gzip.NewReader(strings.NewReader(string(b)))
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
		if name == "" || filepath.IsAbs(name) || strings.HasPrefix(filepath.Clean(name), "..") {
			return fmt.Errorf("путь вне папки: %s", h.Name)
		}
		p := filepath.Join(dir, name)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
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
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			f.Close()
		}
	}
}

func exeName(s string) string {
	if runtime.GOOS == "windows" {
		return s + ".exe"
	}
	return s
}

// keeperBinary — файл keeper этой ОС в папке версии.
func keeperBinary(dir string) string {
	return filepath.Join(dir, osArch(), exeName("keeper"))
}

// osArch — папка файла keeper этой ОС в архиве: windows-amd64, linux-amd64.
func osArch() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

// selfUpdate — новый файл ответил своей версией → подменить свой файл и выйти; ОС поднимет новый.
// Держатели и их процессы живут дальше: новый keeper подключится к ним.
func (k *Keeper) selfUpdate(pp planPart) {
	dir, err := k.install(pp)
	if err != nil {
		k.j.stop("self_update", err.Error(), "to", pp.Version)
		k.keeperFailed(pp.Version, err.Error())
		return
	}
	bin := keeperBinary(dir)
	out, err := exec.Command(bin, "version").Output()
	if got := strings.TrimSpace(string(out)); err != nil || got != pp.Version {
		why := fmt.Sprintf("check_failed: новый файл ответил «%s» (%v), а в плане %s", got, err, pp.Version)
		k.j.stop("self_update", why, "to", pp.Version)
		k.keeperFailed(pp.Version, why)
		return
	}
	self, err := k.self()
	if err != nil {
		k.keeperFailed(pp.Version, err.Error())
		return
	}
	// запущенный файл можно переименовать, но не удалить: держатели держат его, пока живы
	old := self + "." + keeperVersion + ".old"
	os.Remove(old)
	if err := os.Rename(self, old); err != nil {
		k.keeperFailed(pp.Version, "подмена: "+err.Error())
		return
	}
	if err := copyFile(bin, self); err != nil {
		os.Rename(old, self)
		k.keeperFailed(pp.Version, "подмена: "+err.Error())
		return
	}
	k.j.note("self_update", "from", keeperVersion, "to", pp.Version, "why", "файл подменён — выход, ОС поднимет новый")
	k.ledger("part.updated", fmt.Sprintf("%s: keeper %s → %s", k.machine, keeperVersion, pp.Version))
	go func() {
		k.Stop()
		k.exit(3)
	}()
}

func (k *Keeper) keeperFailed(version, why string) {
	k.mu.Lock()
	p := k.parts["keeper"]
	if p == nil {
		p = &part{name: "keeper"}
		k.parts["keeper"] = p
	}
	p.state, p.version, p.err = "failed", version, why
	k.mu.Unlock()
	k.ledger("part.failed", fmt.Sprintf("%s: keeper %s — %s", k.machine, version, why))
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

// cleanupOldSelf — старые файлы keeper после подмены; занятые держателями остаются до следующего старта.
func cleanupOldSelf(self string) {
	ms, _ := filepath.Glob(self + ".*.old")
	for _, m := range ms {
		os.Remove(m)
	}
}
