// Держатель процесса: режим файла keeper, который держит один процесс и переживает своего хозяина. Хозяева — keeper (части машины) и Host (сессии).
//
// Протокол заморожен, Host говорит на тех же байтах. TCP на 127.0.0.1, кадры [тип 1 байт][длина 4 байта, big-endian][данные]:
//
//	хозяин → держатель: 'a' ключ (первым), 'i' ввод, 'c' закрыть ввод, 'k' убить дерево процесса
//	держатель → хозяин: 'h' {pid, buffered}, 'o' вывод, 'x' {code, signal, stderr, os_stop?}, 'e' слово отказа
//
// Этот файл — кадры, файл держателя и сторона хозяина в keeper.
package holder

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"switchboard/keeper/internal/machine"
)

const (
	kAuth  = 'a'
	kInput = 'i'
	kClose = 'c'
	kKill  = 'k'
	kHello = 'h'
	kOut   = 'o'
	kExit  = 'x'
	kError = 'e'

	frameMax = 4 << 20 // кадр больше — сбой соединения: вывод режется на куски
)

func frame(t byte, data []byte) []byte {
	b := make([]byte, 5+len(data))
	b[0] = t
	binary.BigEndian.PutUint32(b[1:5], uint32(len(data)))
	copy(b[5:], data)
	return b
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

// File — procs/<id>.json.
type File struct {
	ID     string `json:"id"`
	Owner  string `json:"owner"`
	Pid    int    `json:"pid"`
	Holder int    `json:"holder"`
	Port   int    `json:"port"`
	Key    string `json:"key"`
	Tag    string `json:"tag,omitempty"`
}

func filePath(home, id string) string { return filepath.Join(home, "procs", id+".json") }

// Files — файлы держателей папки; битый пропускается.
func Files(home string) []File {
	names, _ := filepath.Glob(filepath.Join(home, "procs", "*.json"))
	var out []File
	for _, n := range names {
		var f File
		if b, err := os.ReadFile(n); err == nil && json.Unmarshal(b, &f) == nil && machine.ValidName(f.ID) {
			out = append(out, f)
		}
	}
	return out
}

// Remove — убрать файл держателя, который не отвечает.
func Remove(home, id string) { os.Remove(filePath(home, id)) }

// Spec — что запустить под держателем.
type Spec struct {
	Bin, ID, Owner, Tag, Cwd string
	Detach                   bool
	Env, Cmd                 []string
}

// Spawn — держатель этим же файлом: первая строка его stdout — о себе. Не ответил за wait — убит. Держатель не привязан к жизни хозяина.
func Spawn(s Spec, wait time.Duration) (File, error) {
	args := []string{"hold", "--id", s.ID, "--owner", s.Owner, "--tag", s.Tag, "--cwd", s.Cwd}
	if s.Detach {
		args = append(args, "--detach-children")
	}
	cmd := exec.Command(s.Bin, append(append(args, "--"), s.Cmd...)...)
	cmd.Env = s.Env
	setHolderAttr(cmd)
	var errs bytes.Buffer
	cmd.Stderr = &errs
	out, err := cmd.StdoutPipe()
	if err != nil {
		return File{}, err
	}
	if err := cmd.Start(); err != nil {
		return File{}, fmt.Errorf("держатель не запустился: %w", err)
	}
	type answer struct {
		line string
		err  error
	}
	first := make(chan answer, 1)
	go func() {
		l, err := bufio.NewReader(out).ReadString('\n')
		first <- answer{l, err}
	}()
	var a answer
	select {
	case a = <-first:
	case <-time.After(wait):
		cmd.Process.Kill()
		go cmd.Wait()
		return File{}, fmt.Errorf("держатель не ответил за %v", wait)
	}
	if a.err != nil {
		cmd.Wait()
		return File{}, fmt.Errorf("держатель не запустился: %s", bytes.TrimSpace(errs.Bytes()))
	}
	// держатель живёт сам; Wait забирает его выход — иначе вышедший держатель остаётся зомби, пока жив хозяин (wsl 3 нояб.: 23 зомби за 11 ч)
	go cmd.Wait()
	var r struct {
		Port int    `json:"port"`
		Key  string `json:"key"`
		Pid  int    `json:"pid"`
	}
	if err := json.Unmarshal([]byte(a.line), &r); err != nil {
		return File{}, fmt.Errorf("строка держателя: %w", err)
	}
	return File{ID: s.ID, Owner: s.Owner, Tag: s.Tag, Pid: r.Pid, Port: r.Port, Key: r.Key}, nil
}

// Hello — ответ держателя на ключ.
type Hello struct {
	Pid      int `json:"pid"`
	Buffered int `json:"buffered"`
}

// Exit — кадр выхода. OSStop — держатель закрыл ввод по сигналу остановки от ОС: выход не падение.
type Exit struct {
	Code   *int    `json:"code"`
	OSStop bool    `json:"os_stop,omitempty"`
	Signal *string `json:"signal"`
	Stderr string  `json:"stderr"`
}

// Conn — соединение хозяина с держателем.
type Conn struct {
	c net.Conn
	r *bufio.Reader
}

// Dial — подключиться хозяином: соединение, ключ и ответ не дольше wait.
func Dial(f File, wait time.Duration) (*Conn, Hello, error) {
	var hello Hello
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port), wait)
	if err != nil {
		return nil, hello, err
	}
	fail := func(err error) (*Conn, Hello, error) {
		c.Close()
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			err = fmt.Errorf("держатель не ответил за %v", wait)
		}
		return nil, hello, err
	}
	c.SetDeadline(time.Now().Add(wait))
	if _, err := c.Write(frame(kAuth, []byte(f.Key))); err != nil {
		return fail(err)
	}
	r := bufio.NewReader(c)
	t, b, err := readFrame(r)
	if err != nil {
		return fail(err)
	}
	if t != kHello {
		return fail(fmt.Errorf("держатель отказал: %s", b))
	}
	c.SetDeadline(time.Time{})
	return &Conn{c, r}, hello, json.Unmarshal(b, &hello)
}

// CloseInput — «закрой ввод»: встаёт в очередь за вводом. Кадр не ушёл — обрыв узнает Read.
func (c *Conn) CloseInput() { c.c.Write(frame(kClose, nil)) }

// Kill — «убей» мимо очереди ввода.
func (c *Conn) Kill() { c.c.Write(frame(kKill, nil)) }

// Close — соединение закрыто: держатель и процесс живут; если выход уже забран — держатель уходит.
func (c *Conn) Close() { c.c.Close() }

// Limit — предел чтения от этого мига.
func (c *Conn) Limit(d time.Duration) { c.c.SetReadDeadline(time.Now().Add(d)) }

// Read — вывод до кадра выхода; ошибка — связь оборвалась раньше.
func (c *Conn) Read(onOut func([]byte)) (*Exit, error) {
	for {
		t, b, err := readFrame(c.r)
		if err != nil {
			return nil, err
		}
		switch t {
		case kOut:
			onOut(b)
		case kExit:
			var x Exit
			return &x, json.Unmarshal(b, &x)
		}
	}
}
