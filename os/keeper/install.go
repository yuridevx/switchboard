package main

// Установка версии части: скачать архив по ссылке из плана, сверить sha256, распаковать рядом,
// выполнить setup из app.json, отметить папку хэшем архива. Самообновление keeper — той же дорогой.
import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	if err := strictJSON(b, &a); err != nil {
		return a, fmt.Errorf("contract_mismatch: app.json: %v", err)
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
	os.RemoveAll(dir)
	if err := os.Rename(tmp, dir); err != nil {
		os.RemoveAll(tmp)
		return "", err
	}
	// setup — уже в папке версии: npm на Windows связывает пакеты workspaces ссылками с полным путём,
	// после переименования папки они вели бы в никуда. Версия готова, когда записана метка.
	if a, err := readApp(dir); err == nil && len(a.Setup) > 0 {
		c := k.command(a.Setup, dir)
		ctx, cancel := context.WithTimeout(context.Background(), k.limit)
		defer cancel()
		cmd := exec.CommandContext(ctx, c[0], c[1:]...)
		// потомки setup держат трубу вывода — после убийства не ждать их дольше
		cmd.WaitDelay = 5 * time.Second
		cmd.Dir = dir
		cmd.Env = os.Environ()
		setProcAttr(cmd)
		out, err := cmd.CombinedOutput()
		if ctx.Err() != nil {
			err = fmt.Errorf("не завершился за %v", k.limit)
		}
		if err != nil {
			os.RemoveAll(dir)
			s := strings.TrimSpace(string(out))
			if len(s) > 2000 {
				s = s[len(s)-2000:]
			}
			return "", fmt.Errorf("setup_failed: %v: %s", err, s)
		}
	}
	if err := os.WriteFile(stampPath(dir), []byte(pp.Sha256+"\n"), 0o600); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	k.j.note("installed", "part", pp.Part, "version", pp.Version, "bytes", len(body))
	return dir, nil
}

// untgz — распаковать tgz в папку; пути только внутрь неё, записи — только файлы и папки.
func untgz(b []byte, dir string) error {
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
		default:
			return fmt.Errorf("запись %s вида %q — в архиве части только файлы и папки", h.Name, h.Typeflag)
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

// selfUpdate — новый файл ответил своей версией → подменить свой файл и остановиться; ОС поднимет новый.
// Держатели и их процессы живут дальше: новый keeper подключится к ним. Сбой — keeper failed, как у любой части.
func (k *Keeper) selfUpdate(pp planPart) {
	fail := func(why string) { k.failPart(k.partOf("keeper"), pp.Version, why) }
	dir, err := k.install(pp)
	if err != nil {
		fail(err.Error())
		return
	}
	bin := keeperBinary(dir)
	ctx, cancel := context.WithTimeout(context.Background(), k.limit)
	defer cancel()
	vc := exec.CommandContext(ctx, bin, "version")
	vc.WaitDelay = 5 * time.Second
	out, err := vc.Output()
	if ctx.Err() != nil {
		fail(fmt.Sprintf("check_failed: новый файл не ответил за %v", k.limit))
		return
	}
	if got := strings.TrimSpace(string(out)); err != nil || got != pp.Version {
		fail(fmt.Sprintf("check_failed: новый файл ответил «%s» (%v), а в плане %s", got, err, pp.Version))
		return
	}
	self, err := k.self()
	if err != nil {
		fail(err.Error())
		return
	}
	// прежний файл держат держатели, пока живы, — иногда днями: имя у него каждый раз новое
	old := fmt.Sprintf("%s.%s.%d.old", self, keeperVersion, os.Getpid())
	if err := replaceFile(bin, self, old); err != nil {
		fail("подмена: " + err.Error())
		return
	}
	// свои папки версий — новая и та, с которой уходим: прежний файл для отката лежит рядом
	k.cleanupVersions("keeper", pp.Version, keeperVersion)
	k.j.note("self_update", "from", keeperVersion, "to", pp.Version, "why", "файл подменён — выход, ОС поднимет новый")
	k.ledger("part.updated", fmt.Sprintf("keeper %s → %s", keeperVersion, pp.Version))
	// остановку ждёт цикл, в котором мы сейчас: своей горутиной; выход процесса — по Done у того, кто запустил
	go k.Stop()
}

// replaceFile — src на место dst целиком, как все записи keeper: копия рядом, прежний dst — в old
// (запущенный файл можно переименовать, но не удалить), копия — на место. Не вышло — dst прежний.
func replaceFile(src, dst, old string) error {
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

// cleanupOldSelf — старые файлы keeper после подмены; занятые держателями остаются до следующего старта.
func cleanupOldSelf(self string) {
	ms, _ := filepath.Glob(self + ".*.old")
	for _, m := range ms {
		os.Remove(m)
	}
}
