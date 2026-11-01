package main

// Протокол держателя — заморожен: держатели переживают версии keeper и Host.
// Соединение TCP на 127.0.0.1; в обе стороны — кадры [тип 1 байт][длина 4 байта, big-endian][данные].
//
//	хозяин → держатель: 'a' ключ (первым кадром), 'i' байты ввода, 'c' закрыть ввод, 'k' убить дерево процесса
//	держатель → хозяин: 'h' {"pid","buffered"} (ответ на ключ), 'o' байты вывода, 'x' {"code","signal","stderr"} (процесс вышел),
//	                    'e' слово отказа (bad_key, in_use) — затем соединение закрыто
import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

const (
	frAuth   = 'a'
	frInput  = 'i'
	frClose  = 'c'
	frKill   = 'k'
	frHello  = 'h'
	frOutput = 'o'
	frExit   = 'x'
	frError  = 'e'
)

// frameMax — предел одного кадра: вывод режется на куски, кадр больше — сбой соединения.
const frameMax = 4 << 20

func writeFrame(w io.Writer, t byte, data []byte) error {
	b := make([]byte, 5+len(data))
	b[0] = t
	binary.BigEndian.PutUint32(b[1:5], uint32(len(data)))
	copy(b[5:], data)
	_, err := w.Write(b)
	return err
}

func writeJSONFrame(w io.Writer, t byte, v any) error {
	b, _ := json.Marshal(v)
	return writeFrame(w, t, b)
}

func readFrame(r io.Reader) (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[1:5])
	if n > frameMax {
		return 0, nil, fmt.Errorf("кадр %d байт больше предела", n)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return 0, nil, err
	}
	return h[0], b, nil
}

// exitInfoJSON — код выхода процесса в кадре 'x'.
type exitInfoJSON struct {
	Code   *int    `json:"code"`
	Signal *string `json:"signal"`
	Stderr string  `json:"stderr"`
}

// holderHello — ответ держателя на ключ.
type holderHello struct {
	Pid      int `json:"pid"`
	Buffered int `json:"buffered"`
}
