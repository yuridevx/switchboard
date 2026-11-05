package machine

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Journal — журнал машины: строка JSON на запись в journal/keeper-<день UTC>.jsonl, сразу на диск. Поля читает Host; keeper и держатели пишут в один файл.
type Journal struct {
	dir, machine, who string
	echo              io.Writer // консоль: копия строки; может быть nil
	mu                sync.Mutex
}

// NewJournal — журнал папки home; who — кто пишет.
func NewJournal(home, who string, echo io.Writer) *Journal {
	return &Journal{dir: filepath.Join(home, "journal"), machine: NameOf(Key(home)), who: who, echo: echo}
}

// Line — запись о части part. Поля идут по порядку: t, part, machine, who, kind, ev и остальное парами.
func (j *Journal) Line(part, kind, ev string, kv ...any) {
	t := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	var b bytes.Buffer
	sep := byte('{')
	put := func(k string, v any) {
		b.WriteByte(sep)
		sep = ','
		encode(&b, k)
		b.WriteByte(':')
		encode(&b, v)
	}
	put("t", t)
	put("part", part)
	put("machine", j.machine)
	put("who", j.who)
	put("kind", kind)
	put("ev", ev)
	for i := 0; i+1 < len(kv); i += 2 {
		put(kv[i].(string), kv[i+1])
	}
	b.WriteString("}\n")

	j.mu.Lock()
	defer j.mu.Unlock()
	if os.MkdirAll(j.dir, 0o700) == nil {
		if f, err := os.OpenFile(filepath.Join(j.dir, "keeper-"+t[:10]+".jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			f.Write(b.Bytes())
			f.Close()
		}
	}
	if j.echo != nil {
		j.echo.Write(b.Bytes())
	}
}

// encode — значение без экранирования HTML: журнал читают люди.
func encode(b *bytes.Buffer, v any) {
	e := json.NewEncoder(b)
	e.SetEscapeHTML(false)
	e.Encode(v)
	b.Truncate(b.Len() - 1) // Encode дописывает перевод строки
}

// Lines режет поток на строки; хвост без перевода строки отдаёт Flush.
type Lines struct {
	Emit func(string)
	tail []byte
}

func (l *Lines) Write(b []byte) (int, error) {
	n := len(b)
	for {
		i := bytes.IndexByte(b, '\n')
		if i < 0 {
			l.tail = append(l.tail, b...)
			return n, nil
		}
		l.Emit(strings.TrimRight(string(append(l.tail, b[:i]...)), "\r"))
		l.tail = l.tail[:0]
		b = b[i+1:]
	}
}

// Flush — хвост без перевода строки: причина падения часто в нём.
func (l *Lines) Flush() {
	if len(l.tail) > 0 {
		l.Emit(strings.TrimRight(string(l.tail), "\r"))
		l.tail = l.tail[:0]
	}
}
