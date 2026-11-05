// Папка машины: где она, что в keeper.json и machine.key, запись и подмена файла, POST к Worker'у флота. Формат этих файлов — контракт с Host и установленными keeper.
package machine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Home — папка машины: SWITCHBOARD_HOME или ~/.switchboard. Флот с именем пишет свою папку в это же окружение; держатели и части её наследуют.
func Home() (string, error) {
	if h := os.Getenv("SWITCHBOARD_HOME"); h != "" {
		return h, nil
	}
	u, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(u, ".switchboard"), nil
}

// ValidName — имя части, версии, флота или держателя становится именем файла: без путей.
func ValidName(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.ContainsAny(s, `/\:*?"<>|`)
}

// Conf — что keeper читает из keeper.json. Одна карта адресов; relay — объект своей машины, wss того же адреса.
type Conf struct {
	Node    string            `json:"node"`
	Workers map[string]string `json:"workers"`
}

// ReadConf — файла нет — пусто.
func ReadConf(home string) (Conf, error) {
	var c Conf
	b, err := os.ReadFile(filepath.Join(home, "keeper.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	return c, json.Unmarshal(b, &c)
}

// Key — пропуск машины; нет файла — пусто.
func Key(home string) string {
	b, _ := os.ReadFile(filepath.Join(home, "machine.key"))
	return strings.TrimSpace(string(b))
}

// NameOf — имя машины из её пропуска host.<машина>.…: единственное место, где оно записано.
func NameOf(key string) string {
	if p := strings.Split(key, "."); len(p) > 2 && p[0] == "host" {
		return p[1]
	}
	return ""
}

// WriteAtomic — временный файл и rename: файл на диске всегда целый.
func WriteAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Swap — src на место dst: запущенный файл можно переименовать, но не удалить, поэтому прежний dst уходит в old. Не вышло — dst прежний.
func Swap(src, dst, old string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, b, 0o755); err != nil {
		return err
	}
	if err := os.Rename(dst, old); err != nil && !errors.Is(err, fs.ErrNotExist) {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Rename(old, dst)
		return err
	}
	return nil
}

// Post — кадр Worker'у флота; out — куда разобрать ответ, nil — ответа не ждём.
func Post(ctx context.Context, url string, frame, out any) error {
	body, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("код %d", res.StatusCode)
	}
	return nil
}
