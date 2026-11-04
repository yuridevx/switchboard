// Package machine — папка машины на диске: раскладка, keeper.json, пропуск. Формат этих файлов — контракт с Host и установленными keeper.
package machine

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Home — папка машины: SWITCHBOARD_HOME или ~/.switchboard. Держатели и части наследуют её в окружении.
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

func ConfPath(home string) string            { return filepath.Join(home, "keeper.json") }
func PlanPath(home string) string            { return filepath.Join(home, "plan.json") }
func KeyPath(home string) string             { return filepath.Join(home, "machine.key") }
func JournalDir(home string) string          { return filepath.Join(home, "journal") }
func ProcsDir(home string) string            { return filepath.Join(home, "procs") }
func PartDir(home, part string) string       { return filepath.Join(home, "parts", part) }
func DataDir(home, part string) string       { return filepath.Join(PartDir(home, part), "data") }
func VersionDir(home, part, v string) string { return filepath.Join(PartDir(home, part), v) }

// ValidName — имя части, версии, флота или держателя становится именем файла: без путей.
func ValidName(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.ContainsAny(s, `/\:*?"<>|`)
}

// Conf — keeper.json: { "node": "…", "workers": { "relay": "https://…", "releases": "https://…", "ledger": "https://…", … } } — одна карта адресов;
// relay — объект своей машины, wss того же адреса. Незнакомые поля сохраняются как есть.
type Conf map[string]any

// ReadConf — файла нет — пустая настройка.
func ReadConf(home string) (Conf, error) {
	b, err := os.ReadFile(ConfPath(home))
	if errors.Is(err, fs.ErrNotExist) {
		return Conf{}, nil
	}
	if err != nil {
		return nil, err
	}
	c := Conf{}
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return c, nil
}

// WriteConf — keeper.json всегда целый.
func WriteConf(home string, c Conf) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return WriteAtomic(ConfPath(home), append(b, '\n'))
}

// Node — Node из настройки: у службы может не быть PATH.
func (c Conf) Node() string { s, _ := c["node"].(string); return s }

// Workers — адреса Worker'ов флота: имя → адрес.
func (c Conf) Workers() map[string]string {
	out := map[string]string{}
	m, _ := c["workers"].(map[string]any)
	for k, v := range m {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return out
}

// Key — пропуск машины: им входят и Host, и keeper. Нет файла — пусто.
func Key(home string) string {
	b, err := os.ReadFile(KeyPath(home))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// NameOf — имя машины из её пропуска host.<машина>.…: единственное место, где оно записано.
func NameOf(key string) string {
	if p := strings.Split(key, "."); len(p) > 2 && p[0] == "host" {
		return p[1]
	}
	return ""
}

// WriteAtomic — временный файл и rename: файл на диске всегда целый, прежний или новый.
func WriteAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
