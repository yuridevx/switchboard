// Package holder — держатель: режим файла keeper, который держит один процесс и переживает своего хозяина. Хозяева — keeper (части машины) и Host
// (сессии). Протокол заморожен: держатели переживают версии keeper и Host.
//
// Соединение TCP на 127.0.0.1; в обе стороны кадры [тип 1 байт][длина 4 байта, big-endian][данные].
//
//	хозяин → держатель: 'a' ключ (первым кадром), 'i' байты ввода, 'c' закрыть ввод, 'k' убить дерево процесса
//	держатель → хозяин: 'h' {"pid","buffered"} (ответ на ключ), 'o' байты вывода, 'x' {"code","signal","stderr","os_stop"?}
//	                    (процесс вышел; os_stop — после сигнала остановки от ОС), 'e' слово отказа (bad_key) — затем
//	                    соединение закрыто; новый хозяин вытесняет прежнего
package holder

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

// chunk — кусок вывода в одном кадре.
const chunk = 32 * 1024

func writeFrame(w io.Writer, t byte, data []byte) error {
	b := make([]byte, 5+len(data))
	b[0] = t
	binary.BigEndian.PutUint32(b[1:5], uint32(len(data)))
	copy(b[5:], data)
	_, err := w.Write(b)
	return err
}

func writeJSON(w io.Writer, t byte, v any) error {
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

// Exit — выход процесса в кадре 'x'.
type Exit struct {
	Code   *int    `json:"code"`
	OSStop bool    `json:"os_stop,omitempty"` // держатель закрыл ввод по сигналу остановки от ОС — выход не падение
	Signal *string `json:"signal"`
	Stderr string  `json:"stderr"`
}

// Hello — ответ держателя на ключ.
type Hello struct {
	Pid      int `json:"pid"`
	Buffered int `json:"buffered"`
}
