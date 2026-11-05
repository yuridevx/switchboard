package main

// Держатель глазами keeper: запустить командой hold, подключиться хозяином, закрыть ввод, убить дерево, получить выход.
import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"
)

// attachWait — подключение к живому держателю и его hello.
const attachWait = 5 * time.Second

// holdAbout — строка держателя о себе.
type holdAbout struct {
	Port int    `json:"port"`
	Key  string `json:"key"`
	Pid  int    `json:"pid"`
}

// spawnHolder — keeper hold args с окружением env; строка о себе — за предел wait, иначе держатель убит.
func spawnHolder(args, env []string, wait time.Duration) (holdAbout, error) {
	var a holdAbout
	me, err := os.Executable()
	if err != nil {
		return a, err
	}
	cmd := exec.Command(me, append([]string{"hold"}, args...)...)
	cmd.Env = env
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return a, err
	}
	detached(cmd)
	if err := cmd.Start(); err != nil {
		return a, err
	}
	line := make(chan string, 1)
	go func() { l, _ := bufio.NewReader(out).ReadString('\n'); line <- l }()
	select {
	case l := <-line:
		if l == "" {
			cmd.Wait()
			return a, fmt.Errorf("держатель не запустился: %s", strings.TrimSpace(stderr.String()))
		}
		go cmd.Wait() // держатель живёт сам; Wait забирает его, когда он выйдет
		return a, json.Unmarshal([]byte(l), &a)
	case <-time.After(wait):
		cmd.Process.Kill()
		go cmd.Wait()
		return a, fmt.Errorf("держатель не ответил за %v", wait)
	}
}

// held — соединение хозяина с держателем.
type held struct {
	c        net.Conn
	pid      int
	buffered int
	done     chan struct{} // закрыт: выход получен или связь оборвалась
	exit     *exitInfo     // nil — связь оборвалась без кадра выхода
}

// attach — подключиться хозяином по ключу: hello за attachWait. Кадры держателя читает watch.
func attach(port int, key string) (*held, error) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), attachWait)
	if err != nil {
		return nil, err
	}
	c.SetDeadline(time.Now().Add(attachWait))
	writeFrame(c, 'a', []byte(key))
	t, b, err := readFrame(c)
	if err == nil && t != 'h' {
		err = fmt.Errorf("держатель отказал: %s", b)
	}
	if err != nil {
		c.Close()
		if os.IsTimeout(err) {
			err = fmt.Errorf("держатель не ответил за %v", attachWait)
		}
		return nil, err
	}
	c.SetDeadline(time.Time{})
	var hello struct{ Pid, Buffered int }
	json.Unmarshal(b, &hello)
	return &held{c: c, pid: hello.Pid, buffered: hello.Buffered, done: make(chan struct{})}, nil
}

// watch — кадры держателя до выхода или обрыва: вывод части keeper не читает (его пишет в журнал держатель); onDone — раньше, чем done.
func (h *held) watch(onDone func(*held)) {
	go func() {
		for {
			t, b, err := readFrame(h.c)
			if err != nil {
				break
			}
			if t == 'x' {
				h.exit = &exitInfo{}
				json.Unmarshal(b, h.exit)
				break
			}
		}
		h.c.Close() // выход забран: держатель убирает свой файл и выходит
		onDone(h)
		close(h.done)
	}()
}

func (h *held) closeInput() { writeFrame(h.c, 'c', nil) }
func (h *held) kill()       { writeFrame(h.c, 'k', nil) }

// why — выход словами: код, сигнал, остановка ОС, последняя строка stderr.
func (h *held) why() string {
	x := h.exit
	if x == nil {
		return "связь с держателем оборвалась"
	}
	s := "код ?"
	if x.Signal != nil {
		s = "сигнал " + *x.Signal
	} else if x.Code != nil {
		s = fmt.Sprintf("код %d", *x.Code)
	}
	if x.OSStop {
		s = "остановка ОС: " + s
	}
	if x.Stderr != "" {
		s += ": " + x.Stderr
	}
	return s
}
