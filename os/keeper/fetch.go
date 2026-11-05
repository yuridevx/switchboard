package main

// Версия части на диске: parts/<часть>/<версия>/ — архив по ссылке, сверенный sha256 и распакованный, app.json, setup; release.sha256 —
// метка готовой версии. Готовая версия ставится с диска, без ссылки: ссылка из плана живёт час.
//   app.json — { run: [команда…], setup?: [команда…], detach_children?: true }; node — Node из keeper.json, npm — npm-cli.js рядом с ним.
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
	"strings"
	"time"
)

type app struct {
	Run    []string `json:"run"`
	Setup  []string `json:"setup,omitempty"`
	Detach bool     `json:"detach_children,omitempty"`
}

// install — версия готова на диске; withApp — с app.json и setup (у keeper их нет).
func (k *Keeper) install(e entry, withApp bool) (dir string, a app, err error) {
	if !simpleName(e.Part) || !simpleName(e.Version) {
		return "", a, fmt.Errorf("bad_plan: часть «%s» версия «%s»", e.Part, e.Version)
	}
	dir = filepath.Join(k.partDir(e.Part), e.Version)
	stamp := filepath.Join(dir, "release.sha256")
	if b, err := os.ReadFile(stamp); err == nil && (e.Sha256 == "" || strings.TrimSpace(string(b)) == e.Sha256) {
		if withApp {
			a, err = readApp(dir)
		}
		return dir, a, err
	}
	if e.URL == "" {
		return "", a, fmt.Errorf("download_failed: %s %s нет на диске и нет ссылки", e.Part, e.Version)
	}
	os.RemoveAll(dir)
	err = k.download(e, dir)
	if err == nil && withApp {
		if a, err = readApp(dir); err == nil && len(a.Setup) > 0 {
			err = k.setup(dir, a.Setup)
		}
	}
	if err == nil {
		err = os.WriteFile(stamp, []byte(e.Sha256+"\n"), 0o600)
	}
	if err != nil {
		os.RemoveAll(dir)
		return "", a, err
	}
	k.j.add("keeper", e.Part, "note", "installed", "version", e.Version)
	return dir, a, nil
}

// download — архив по ссылке за предел, sha256, распаковка. В ошибке нет ссылки: её подпись — секрет.
func (k *Keeper) download(e entry, dir string) error {
	ctx, cancel := context.WithTimeout(k.ctx, k.o.Download)
	defer cancel()
	what := e.Part + " " + e.Version
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.URL, nil)
	if err != nil {
		return fmt.Errorf("download_failed: GET %s: ссылка не разобрана", what)
	}
	var b []byte
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("download_failed: GET %s: %d", what, resp.StatusCode)
		}
		b, err = io.ReadAll(resp.Body)
	}
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return fmt.Errorf("download_failed: GET %s: %v", what, err)
	}
	sum := sha256.Sum256(b)
	if got := hex.EncodeToString(sum[:]); got != e.Sha256 {
		return fmt.Errorf("download_failed: sha256 %s — в плане %s, у архива %s", what, e.Sha256, got)
	}
	if err := unpack(b, dir); err != nil {
		return fmt.Errorf("download_failed: распаковка: %v", err)
	}
	return nil
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
			return fmt.Errorf("запись %s вида '%c' — в архиве части только файлы и папки", h.Name, h.Typeflag)
		}
		if err != nil {
			return err
		}
	}
}

func readApp(dir string) (app, error) {
	var a app
	b, err := os.ReadFile(filepath.Join(dir, "app.json"))
	if err != nil {
		return a, fmt.Errorf("no_app_json: в версии нет app.json: %v", err)
	}
	if err := decodePlan(b, &a); err != nil {
		return a, fmt.Errorf("contract_mismatch: app.json: %v", err)
	}
	if len(a.Run) == 0 {
		return a, errors.New("contract_mismatch: app.json без run")
	}
	return a, nil
}

// setup — команда setup в папке версии за предел.
func (k *Keeper) setup(dir string, cmd []string) error {
	ctx, cancel := context.WithTimeout(k.ctx, k.o.Stop)
	defer cancel()
	c := k.resolve(cmd, dir)
	x := exec.CommandContext(ctx, c[0], c[1:]...)
	x.Dir, x.WaitDelay = dir, waitDelay
	out, err := x.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("setup_failed: не завершился за %v", k.o.Stop)
	}
	if err != nil {
		text := strings.TrimSpace(string(out))
		if len(text) > 2000 {
			text = text[len(text)-2000:]
		}
		return fmt.Errorf("setup_failed: %v: %s", err, text)
	}
	return nil
}

// waitDelay — команда вышла или убита, а потомок держит её вывод.
const waitDelay = 5 * time.Second

// resolve — команда app.json: node — из keeper.json, npm — npm-cli.js рядом с ним под тем же Node (у Windows — рядом, у Linux — в
// ../lib/node_modules); аргумент, который есть в папке версии, — полным путём.
func (k *Keeper) resolve(cmd []string, dir string) []string {
	out := append([]string{}, cmd...)
	switch node := k.c.Node; {
	case node != "" && out[0] == "node":
		out[0] = node
	case node != "" && out[0] == "npm":
		for _, cli := range []string{filepath.Join(filepath.Dir(node), "node_modules", "npm", "bin", "npm-cli.js"),
			filepath.Join(filepath.Dir(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")} {
			if fileExists(cli) {
				out = append([]string{node, cli}, out[1:]...)
				break
			}
		}
	}
	for i := 1; i < len(out); i++ {
		if p := filepath.Join(dir, out[i]); !filepath.IsAbs(out[i]) && fileExists(p) {
			out[i] = p
		}
	}
	return out
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }
