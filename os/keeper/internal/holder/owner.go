package holder

// Сторона хозяина в keeper: запустить держатель этим же файлом и говорить с ним. Host говорит с держателем своим кодом, на тех же кадрах.
import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Spec — что запустить под держателем.
type Spec struct {
	ID, Owner, Tag, Cwd string
	Env                 []string
	Detach              bool
	Cmd                 []string
}

// Spawn — держатель и его строка о себе не дольше wait. Держатель не привязан к жизни хозяина.
func Spawn(home string, s Spec, wait time.Duration) (File, error) {
	self, err := os.Executable()
	if err != nil {
		return File{}, err
	}
	args := []string{"hold", "--id", s.ID, "--owner", s.Owner}
	if s.Cwd != "" {
		args = append(args, "--cwd", s.Cwd)
	}
	if s.Tag != "" {
		args = append(args, "--tag", s.Tag)
	}
	if s.Detach {
		args = append(args, "--detach-children")
	}
	cmd := exec.Command(self, append(append(args, "--"), s.Cmd...)...)
	cmd.Env = append(append([]string{}, s.Env...), "SWITCHBOARD_HOME="+home)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return File{}, err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	setHolderAttr(cmd)
	if err := cmd.Start(); err != nil {
		return File{}, err
	}
	type result struct {
		line string
		err  error
	}
	got := make(chan result, 1)
	go func() {
		l, e := bufio.NewReader(out).ReadString('\n')
		got <- result{l, e}
	}()
	var r result
	select {
	case r = <-got:
	case <-time.After(wait):
		cmd.Process.Kill()
		cmd.Wait()
		return File{}, fmt.Errorf("держатель не ответил за %v", wait)
	}
	if r.err != nil && r.line == "" {
		cmd.Wait()
		return File{}, fmt.Errorf("держатель не запустился: %s", strings.TrimSpace(stderr.String()))
	}
	// держатель живёт сам; Wait забирает его выход — иначе вышедший держатель остаётся зомби, пока жив хозяин (wsl 3 нояб.: 23 зомби за 11 ч)
	go cmd.Wait()
	var about struct {
		Port int    `json:"port"`
		Key  string `json:"key"`
		Pid  int    `json:"pid"`
	}
	if err := json.Unmarshal([]byte(r.line), &about); err != nil {
		return File{}, fmt.Errorf("строка держателя: %v", err)
	}
	return File{ID: s.ID, Owner: s.Owner, Tag: s.Tag, Pid: about.Pid, Port: about.Port, Key: about.Key}, nil
}

// Conn — соединение хозяина с держателем.
type Conn struct {
	c  net.Conn
	mu sync.Mutex
}

// Dial — подключиться к держателю по файлу о нём: соединение, ключ и ответ не дольше wait.
func Dial(f File, wait time.Duration) (*Conn, Hello, error) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", f.Port), wait)
	if err != nil {
		return nil, Hello{}, err
	}
	c.SetDeadline(time.Now().Add(wait))
	if err := writeFrame(c, frAuth, []byte(f.Key)); err != nil {
		c.Close()
		return nil, Hello{}, err
	}
	t, b, err := readFrame(c)
	if err != nil {
		c.Close()
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			err = fmt.Errorf("держатель не ответил за %v", wait)
		}
		return nil, Hello{}, err
	}
	c.SetDeadline(time.Time{})
	if t == frError {
		c.Close()
		return nil, Hello{}, fmt.Errorf("держатель отказал: %s", b)
	}
	var h Hello
	json.Unmarshal(b, &h)
	return &Conn{c: c}, h, nil
}

func (c *Conn) send(t byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	writeFrame(c.c, t, nil)
}

// CloseInput — закрыть ввод процессу. Кадр не ушёл — обрыв узнает Read.
func (c *Conn) CloseInput() { c.send(frClose) }

// Kill — убить дерево процесса.
func (c *Conn) Kill() { c.send(frKill) }

// Close — закрыть соединение: держатель и процесс живут.
func (c *Conn) Close() { c.c.Close() }

// Read — кадры держателя: вывод в onOut; выход — ответом; обрыв — ошибкой.
func (c *Conn) Read(onOut func([]byte)) (*Exit, error) {
	br := bufio.NewReader(c.c)
	for {
		t, b, err := readFrame(br)
		if err != nil {
			return nil, err
		}
		switch t {
		case frOutput:
			onOut(b)
		case frExit:
			var x Exit
			json.Unmarshal(b, &x)
			return &x, nil
		}
	}
}
