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

// keeper.json: { "node": "…", "machine": "win", "relay": "wss://…" }; ключ машины — machine.key рядом.
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

func confStr(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// writeConf — временный файл и rename: keeper.json всегда целый.
func writeConf(home string, m map[string]any) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := confPath(home) + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, confPath(home))
}

