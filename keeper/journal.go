package main

// Папка флота на машине: журнал, keeper.json и machine.key.
//   journal/keeper-<дата UTC>.jsonl — строка JSON на запись в форме LogLine протокола: t (мс), level (info | warn | error), part "keeper",
//     module (keeper | holder), msg и поля записи; Keeper и держатели пишут в один файл, Host читает его запросом machine.journal.
//   keeper.json — { base, machine, node }: адрес флота, имя машины, путь к Node.
//   machine.key — пропуск машины флот:номер:секрет.
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
	dir, fleet, machine string
	mu                  sync.Mutex
}

func newJournal(home, fleet, machine string) *journal {
	return &journal{dir: filepath.Join(home, "journal"), fleet: fleet, machine: machine}
}

// add — строка журнала; kv — пары имя, значение.
func (j *journal) add(module, level, msg string, kv ...any) { j.write(j.record(module, level, msg, kv...)) }

// record — строка журнала с переводом строки, ещё не записанная.
func (j *journal) record(module, level, msg string, kv ...any) []byte {
	r := map[string]any{"t": time.Now().UnixMilli(), "level": level, "part": "keeper", "module": module, "msg": msg}
	if j.fleet != "" {
		r["fleet"] = j.fleet
	}
	if j.machine != "" {
		r["machine"] = j.machine
	}
	for i := 0; i+1 < len(kv); i += 2 {
		r[kv[i].(string)] = kv[i+1]
	}
	var b bytes.Buffer
	e := json.NewEncoder(&b) // перевод строки дописывает Encode
	e.SetEscapeHTML(false)   // журнал читают люди
	e.Encode(r)
	return b.Bytes()
}

// write — готовые строки одной записью в файл дня.
func (j *journal) write(b []byte) {
	if len(b) == 0 {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	os.MkdirAll(j.dir, 0o700)
	f, err := os.OpenFile(filepath.Join(j.dir, "keeper-"+time.Now().UTC().Format("2006-01-02")+".jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	f.Write(b)
	f.Close()
}

// conf — keeper.json.
type conf struct {
	Base    string `json:"base"`
	Machine string `json:"machine"`
	Node    string `json:"node"`
}

// readConf — keeper.json; файла нет — пустой.
func readConf(home string) (conf, error) {
	var c conf
	b, err := os.ReadFile(filepath.Join(home, "keeper.json"))
	if os.IsNotExist(err) {
		return c, nil
	}
	if err == nil {
		err = json.Unmarshal(b, &c)
	}
	return c, err
}

func (c conf) write(home string) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	return writeFile(filepath.Join(home, "keeper.json"), append(b, '\n'))
}

// passFleet — флот пропуска или приглашения флот:номер:секрет; не той формы — пусто.
func passFleet(key string) string {
	p := strings.Split(key, ":")
	if len(p) != 3 || !simpleName(p[0]) || p[1] == "" || len(p[2]) < 16 {
		return ""
	}
	return p[0]
}

// machineKey — пропуск машины и его флот; файла нет — пусто.
func machineKey(home string) (key, fleet string) {
	b, _ := os.ReadFile(filepath.Join(home, "machine.key"))
	key = strings.TrimSpace(string(b))
	return key, passFleet(key)
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
