package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// homeDir — ~/.switchboard или SWITCHBOARD_HOME.
func homeDir() (string, error) {
	if h := os.Getenv("SWITCHBOARD_HOME"); h != "" {
		return h, nil
	}
	u, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(u, ".switchboard"), nil
}

// keeper.json: { "node": "…", "relay": "wss://…", "workers": { "releases": "https://…", "ledger": "https://…", … } };
// пропуск машины — machine.key рядом, имя машины — в пропуске.
// Незнакомые поля сохраняются как есть.
func confPath(home string) string { return filepath.Join(home, "keeper.json") }

func readConf(home string) (map[string]any, error) {
	b, err := os.ReadFile(confPath(home))
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	m := map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// confMap — объект строк из keeper.json: workers.
func confMap(m map[string]any, k string) map[string]string {
	out := map[string]string{}
	if x, ok := m[k].(map[string]any); ok {
		for kk, v := range x {
			if s, ok := v.(string); ok {
				out[kk] = s
			}
		}
	}
	return out
}

func confStr(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// writeConf — keeper.json всегда целый.
func writeConf(home string, m map[string]any) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(confPath(home), append(b, '\n'))
}

// writeFileAtomic — временный файл и rename: файл keeper на диске всегда целый — прежний или новый.
func writeFileAtomic(p string, b []byte) error {
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}
