// Package journal — журнал машины: строка JSON на событие, файл journal/keeper-<дата UTC>.jsonl; поля читает Host. Каждая строка пишется сразу.
package journal

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type sink struct {
	mu   sync.Mutex
	dir  string
	echo io.Writer // консоль: копия строки
}

// Journal — чьи строки: who пишет, part и callsign — о ком.
type Journal struct {
	s                   *sink
	machine             string
	who, part, callsign string
}

// New — журнал keeper. echo — копия строк (консоль), может быть nil.
func New(dir, machine string, echo io.Writer) *Journal {
	return &Journal{s: &sink{dir: dir, echo: echo}, machine: machine, who: "keeper", part: "keeper"}
}

// For — тот же журнал со строками о части машины.
func (j *Journal) For(part string) *Journal {
	c := *j
	c.part = part
	return &c
}

// Holder — строки держателя: под тем, чей процесс он держит — часть машины своим именем, сессия Host — host и callsign.
func (j *Journal) Holder(part, callsign string) *Journal {
	c := *j
	c.who, c.part, c.callsign = "holder", part, callsign
	return &c
}

// Note — обычный переход. kv — пары «поле, значение» в порядке записи.
func (j *Journal) Note(ev string, kv ...any) { j.write("note", ev, kv) }

// Stop — сбой: причина словами обязательна.
func (j *Journal) Stop(ev, why string, kv ...any) {
	j.write("stop", ev, append([]any{"why", why}, kv...))
}

// Refuse — отказ со словом из контракта.
func (j *Journal) Refuse(ev, word, why string) {
	j.write("refuse", ev, []any{"word", word, "why", why})
}

func (j *Journal) write(kind, ev string, kv []any) {
	t := time.Now().UTC()
	var b bytes.Buffer
	sep := byte('{')
	put := func(k string, v any) {
		b.WriteByte(sep)
		sep = ','
		enc(&b, k)
		b.WriteByte(':')
		enc(&b, v)
	}
	put("t", t.Format("2006-01-02T15:04:05.000Z"))
	put("part", j.part)
	put("machine", j.machine)
	put("who", j.who)
	put("kind", kind)
	put("ev", ev)
	if j.callsign != "" {
		put("callsign", j.callsign)
	}
	for i := 0; i+1 < len(kv); i += 2 {
		k, _ := kv[i].(string)
		put(k, kv[i+1])
	}
	b.WriteString("}\n")

	j.s.mu.Lock()
	defer j.s.mu.Unlock()
	if os.MkdirAll(j.s.dir, 0o700) == nil {
		name := filepath.Join(j.s.dir, "keeper-"+t.Format("2006-01-02")+".jsonl")
		if f, err := os.OpenFile(name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			f.Write(b.Bytes())
			f.Close()
		}
	}
	if j.s.echo != nil {
		j.s.echo.Write(b.Bytes())
	}
}

// enc — значение без экранирования HTML: журнал читают люди.
func enc(b *bytes.Buffer, v any) {
	e := json.NewEncoder(b)
	e.SetEscapeHTML(false)
	e.Encode(v)
	b.Truncate(b.Len() - 1) // Encode дописывает перевод строки
}
