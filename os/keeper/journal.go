package main

// Папка машины: журнал, keeper.json и machine.key.
//   journal/keeper-<дата UTC>.jsonl — строка JSON на запись: t, part, machine, who (keeper | holder), kind (stop | refuse | note), ev и поля
//     записи; keeper и держатели пишут в один файл, Host читает его запросом machine.journal.
//   keeper.json — { node, workers: { <имя Worker'а>: адрес } } и незнакомые поля, они сохраняются как есть.
//   machine.key — пропуск машины host.<машина>.<номер>.<секрет>.
import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type journal struct {
	dir, machine string
	mu           sync.Mutex
}

func newJournal(home, machine string) *journal {
	return &journal{dir: filepath.Join(home, "journal"), machine: machine}
}

// add — строка журнала; kv — пары имя, значение.
func (j *journal) add(who, part, kind, ev string, kv ...any) {
	t := time.Now().UTC()
	r := map[string]any{"t": t.Format("2006-01-02T15:04:05.000Z"), "part": part, "machine": j.machine, "who": who, "kind": kind, "ev": ev}
	for i := 0; i+1 < len(kv); i += 2 {
		r[kv[i].(string)] = kv[i+1]
	}
	var b bytes.Buffer
	e := json.NewEncoder(&b) // перевод строки дописывает Encode
	e.SetEscapeHTML(false)   // журнал читают люди
	e.Encode(r)
	j.mu.Lock()
	defer j.mu.Unlock()
	os.MkdirAll(j.dir, 0o700)
	f, err := os.OpenFile(filepath.Join(j.dir, "keeper-"+t.Format("2006-01-02")+".jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	f.Write(b.Bytes())
	f.Close()
}

// conf — keeper.json: что читает keeper, и всё прочее как есть.
type conf struct {
	Node    string
	Workers map[string]string
	raw     map[string]json.RawMessage
}

// readConf — keeper.json; файла нет — пустой.
func readConf(home string) (conf, error) {
	c := conf{raw: map[string]json.RawMessage{}}
	b, err := os.ReadFile(filepath.Join(home, "keeper.json"))
	if os.IsNotExist(err) {
		return c, nil
	}
	if err == nil {
		err = json.Unmarshal(b, &c.raw)
	}
	if err == nil {
		json.Unmarshal(c.raw["node"], &c.Node)
		err = json.Unmarshal(orNull(c.raw["workers"]), &c.Workers)
	}
	return c, err
}

func orNull(b json.RawMessage) json.RawMessage {
	if b == nil {
		return json.RawMessage("null")
	}
	return b
}

func (c conf) write(home string) error {
	c.raw["node"], _ = json.Marshal(c.Node)
	c.raw["workers"], _ = json.Marshal(c.Workers)
	b, _ := json.MarshalIndent(c.raw, "", "  ")
	return writeFile(filepath.Join(home, "keeper.json"), append(b, '\n'))
}

// machineKey — пропуск машины и имя машины из него; файла нет — пусто.
func machineKey(home string) (key, machine string) {
	b, _ := os.ReadFile(filepath.Join(home, "machine.key"))
	key = strings.TrimSpace(string(b))
	if p := strings.Split(key, "."); len(p) == 4 && p[0] == "host" {
		machine = p[1]
	}
	return key, machine
}

// writeFile — файл целиком через временный рядом: читатель не видит половины.
func writeFile(path string, b []byte) error {
	os.MkdirAll(filepath.Dir(path), 0o700)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
