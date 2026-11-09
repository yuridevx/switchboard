package main

// Сборка Host на диске: host/<сборка>/ — архив по ссылке плана, сверенный sha256 и распакованный; есть package-lock.json — npm ci;
// build.sha256 — метка готовой сборки. Готовая сборка ставится с диска, без ссылки: ссылка из плана живёт час. host/data — данные Host.
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
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// installed — папка готовой сборки на диске.
func (k *Keeper) installed(build int) (string, error) {
	dir := filepath.Join(k.hostDir(), strconv.Itoa(build))
	if !fileExists(filepath.Join(dir, "build.sha256")) {
		return "", fmt.Errorf("download_failed: сборки %d нет на диске", build)
	}
	return dir, nil
}

// installHost — сборка плана готова на диске.
func (k *Keeper) installHost(p plan) (string, error) {
	dir := filepath.Join(k.hostDir(), strconv.Itoa(p.Build))
	stamp := filepath.Join(dir, "build.sha256")
	if b, err := os.ReadFile(stamp); err == nil && (p.Host.Sha256 == "" || strings.TrimSpace(string(b)) == p.Host.Sha256) {
		return dir, nil
	}
	if p.Host.URL == "" {
		return "", fmt.Errorf("download_failed: сборки %d нет на диске и нет ссылки", p.Build)
	}
	os.RemoveAll(dir)
	b, err := k.fetch(fmt.Sprintf("Host %d", p.Build), p.Host)
	if err == nil {
		if err = unpack(b, dir); err != nil {
			err = fmt.Errorf("download_failed: распаковка: %v", err)
		}
	}
	if err == nil && fileExists(filepath.Join(dir, "package-lock.json")) {
		err = k.setup(dir)
	}
	if err == nil {
		err = os.WriteFile(stamp, []byte(p.Host.Sha256+"\n"), 0o600)
	}
	if err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	k.note("installed", "build", p.Build)
	return dir, nil
}

// fetch — файл по ссылке за предел, сверенный sha256. В ошибке нет ссылки: её подпись — секрет.
func (k *Keeper) fetch(what string, f planFile) ([]byte, error) {
	ctx, cancel := context.WithTimeout(k.ctx, k.o.Download)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return nil, fmt.Errorf("download_failed: GET %s: ссылка не разобрана", what)
	}
	var b []byte
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("download_failed: GET %s: %d", what, resp.StatusCode)
		}
		b, err = io.ReadAll(resp.Body)
	}
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("download_failed: GET %s: %v", what, err)
	}
	sum := sha256.Sum256(b)
	if got := hex.EncodeToString(sum[:]); got != f.Sha256 {
		return nil, fmt.Errorf("download_failed: sha256 %s — в плане %s, у файла %s", what, f.Sha256, got)
	}
	return b, nil
}

// fileSha — sha256 файла.
func fileSha(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// unpack — tar.gz в dir: только файлы и папки, только внутри dir.
func unpack(b []byte, dir string) error {
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
		path := filepath.Join(dir, h.Name)
		if rel, err := filepath.Rel(dir, path); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("путь вне папки: %s", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(path, 0o700)
		case tar.TypeReg:
			os.MkdirAll(filepath.Dir(path), 0o700)
			var f *os.File
			if f, err = os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(h.Mode)&0o755|0o600); err == nil {
				_, err = io.Copy(f, tr)
				f.Close()
			}
		default:
			return fmt.Errorf("запись %s вида '%c' — в архиве сборки только файлы и папки", h.Name, h.Typeflag)
		}
		if err != nil {
			return err
		}
	}
}

// setup — npm ci в папке сборки в своём дереве процессов: по пределу снято всё дерево, иначе потомки держат папку. Остановка keeper начатый
// npm ci доводит в пределах предела: следующему keeper не качать архив, ссылка на который могла истечь.
func (k *Keeper) setup(dir string) error {
	ctx, cancel := context.WithTimeout(context.Background(), k.o.Stop)
	defer cancel()
	c := append(k.npm(), "ci")
	x := exec.Command(c[0], c[1:]...)
	var out bytes.Buffer
	x.Dir, x.WaitDelay, x.Stdout, x.Stderr = dir, waitDelay, &out, &out
	t := newTree(x, false)
	err := x.Start()
	if err == nil {
		t.adopt(x.Process)
		stop := context.AfterFunc(ctx, t.kill) // снятие — только после adopt: дерево уже известно
		err = x.Wait()
		stop()
	}
	t.reap()
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("setup_failed: npm ci не завершился за %v", k.o.Stop)
	}
	if err != nil {
		text := strings.TrimSpace(out.String())
		if len(text) > 2000 {
			text = text[len(text)-2000:]
		}
		return fmt.Errorf("setup_failed: npm ci: %v: %s", err, text)
	}
	return nil
}

// waitDelay — команда вышла или убита, а потомок держит её вывод.
const waitDelay = 5 * time.Second

// node — Node из keeper.json; не записан — из PATH.
func (k *Keeper) node() string {
	if k.c.Node != "" {
		return k.c.Node
	}
	return "node"
}

// npm — npm-cli.js рядом с Node из keeper.json под тем же Node (у Windows — рядом, у Linux — в ../lib/node_modules); не найден — npm из PATH.
func (k *Keeper) npm() []string {
	if node := k.c.Node; node != "" {
		for _, cli := range []string{filepath.Join(filepath.Dir(node), "node_modules", "npm", "bin", "npm-cli.js"),
			filepath.Join(filepath.Dir(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")} {
			if fileExists(cli) {
				return []string{node, cli}
			}
		}
	}
	return []string{"npm"}
}

// prune — папки сборок Host, кроме keep и data; занятую ОС не даёт удалить — остаётся до следующей смены.
func (k *Keeper) prune(keep ...string) {
	es, _ := os.ReadDir(k.hostDir())
	for _, d := range es {
		name := d.Name()
		if name == "data" || name == keep[0] || len(keep) > 1 && name == keep[1] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(k.hostDir(), name)); err != nil {
			k.note("cleanup", "build", name, "why", "занята: "+err.Error())
		}
	}
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }
