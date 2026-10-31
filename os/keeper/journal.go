package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Journal — журнал keeper: строка JSON на событие в общем формате журнала машины,
// файл ~/.switchboard/journal/keeper-<дата UTC>.jsonl. Каждая строка пишется сразу.
type Journal struct {
	mu      sync.Mutex
	dir     string
	machine string
	echo    io.Writer // консольный режим: копия строки в stderr
	now     func() time.Time
}

func newJournal(dir, machine string, echo io.Writer) *Journal {
	return &Journal{dir: dir, machine: machine, echo: echo, now: time.Now}
}

// write — одна запись; kv — пары «поле, значение» в порядке записи.
func (j *Journal) write(kind, ev string, kv ...any) {
	t := j.now().UTC()
	var b bytes.Buffer
	b.WriteByte('{')
	field(&b, "t", t.Format("2006-01-02T15:04:05.000Z"), true)
	field(&b, "part", "keeper", false)
	field(&b, "machine", j.machine, false)
	field(&b, "who", "keeper", false)
	field(&b, "kind", kind, false)
	field(&b, "ev", ev, false)
	for i := 0; i+1 < len(kv); i += 2 {
		k, _ := kv[i].(string)
		field(&b, k, kv[i+1], false)
	}
	b.WriteString("}\n")

	j.mu.Lock()
	defer j.mu.Unlock()
	if err := os.MkdirAll(j.dir, 0o700); err == nil {
		name := filepath.Join(j.dir, "keeper-"+t.Format("2006-01-02")+".jsonl")
		if f, err := os.OpenFile(name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			f.Write(b.Bytes())
			f.Close()
		}
	}
	if j.echo != nil {
		j.echo.Write(b.Bytes())
	}
}

func field(b *bytes.Buffer, k string, v any, first bool) {
	if !first {
		b.WriteByte(',')
	}
	writeJSON(b, k)
	b.WriteByte(':')
	writeJSON(b, v)
}

func writeJSON(b *bytes.Buffer, v any) {
	e := json.NewEncoder(b)
	e.SetEscapeHTML(false)
	e.Encode(v)
	b.Truncate(b.Len() - 1) // Encode дописывает перевод строки
}

// note — обычный переход: старт, spawn, attach, обновление.
func (j *Journal) note(ev string, kv ...any) { j.write("note", ev, kv...) }

// stop — сбой: причина словами обязательна.
func (j *Journal) stop(ev, why string, kv ...any) {
	j.write("stop", ev, append([]any{"why", why}, kv...)...)
}

// refuse — отказ со словом из контракта.
func (j *Journal) refuse(ev, word, why string, kv ...any) {
	j.write("refuse", ev, append([]any{"word", word, "why", why}, kv...)...)
}
