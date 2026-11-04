// Package link — связь keeper с флотом: вебсокет к relay своей машины и прямой POST к Worker'ам. Тот же протокол и те же паузы, что у клиента relay в
// Host: ping раз в 30 с, нет pong к следующему — соединение мёртвое; переподключение с паузой от 1 с, вдвое до 60 с.
package link

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// proto — версия контракта relay в hello.
const proto = 1

// dialWait — предел установки соединения.
const dialWait = 20 * time.Second

// Frame — кадр: поля конверта и всё остальное.
type Frame map[string]any

// Str — строковое поле кадра.
func (f Frame) Str(k string) string { s, _ := f[k].(string); return s }

// Relay — соединение keeper с relay: ключом машины и part: "keeper" в hello, адрес .keeper@машина.
type Relay struct {
	URL, Key                   string
	Ping, PauseFirst, PauseMax time.Duration
	OnOpen                     func()      // hello принят; своей горутиной: чтение кадров его не ждёт, Close — ждёт
	OnFrame                    func(Frame) // кадр, кроме roster
	OnClosed                   func(why string)

	mu     sync.Mutex
	ws     *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	opens  sync.WaitGroup
}

// Start — держать связь до Close, своей горутиной.
func (r *Relay) Start() {
	r.ctx, r.cancel = context.WithCancel(context.Background())
	r.done = make(chan struct{})
	go func() {
		defer close(r.done)
		pause := r.PauseFirst
		for r.ctx.Err() == nil {
			opened, why := r.session()
			r.OnClosed(why)
			if opened {
				pause = r.PauseFirst
			}
			select {
			case <-r.ctx.Done():
				return
			case <-time.After(pause):
			}
			pause = min(pause*2, r.PauseMax)
		}
	}()
}

// session — одно соединение: hello, чтение до обрыва. opened — hello принят: relay отвечает на него roster, первым кадром.
func (r *Relay) session() (opened bool, why string) {
	dial, cancel := context.WithTimeout(r.ctx, dialWait)
	ws, _, err := websocket.Dial(dial, r.URL, nil)
	cancel()
	if err != nil {
		return false, "dial: " + err.Error()
	}
	defer ws.CloseNow()
	ws.SetReadLimit(16 << 20)
	hello, _ := json.Marshal(Frame{"type": "hello", "key": r.Key, "proto": proto, "part": "keeper"})
	if err := ws.Write(r.ctx, websocket.MessageText, hello); err != nil {
		return false, "hello: " + err.Error()
	}
	r.mu.Lock()
	r.ws = ws
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.ws = nil
		r.mu.Unlock()
	}()
	pong := make(chan struct{}, 1)
	stop := make(chan struct{})
	defer close(stop)
	go r.ping(ws, pong, stop)
	for {
		_, b, err := ws.Read(r.ctx)
		if err != nil {
			return opened, err.Error()
		}
		if string(b) == "pong" {
			select {
			case pong <- struct{}{}:
			default:
			}
			continue
		}
		var f Frame
		if json.Unmarshal(b, &f) != nil {
			continue
		}
		if !opened {
			opened = true
			r.opens.Add(1)
			go func() {
				defer r.opens.Done()
				r.OnOpen()
			}()
		}
		if t := f.Str("type"); t != "roster" && t != "reply" {
			r.OnFrame(f)
		}
	}
}

func (r *Relay) ping(ws *websocket.Conn, pong, stop <-chan struct{}) {
	t := time.NewTicker(r.Ping)
	defer t.Stop()
	waiting := false
	for {
		select {
		case <-stop:
			return
		case <-pong:
			waiting = false
		case <-t.C:
			if waiting {
				ws.Close(websocket.StatusGoingAway, "no pong")
				return
			}
			waiting = true
			ws.Write(r.ctx, websocket.MessageText, []byte("ping"))
		}
	}
}

// Answer — ответ на запрос кадра req; word — слово отказа. Связи нет — ответ пропал, спросивший ждёт своим пределом.
func (r *Relay) Answer(req Frame, result any, word string) {
	f := Frame{"type": "reply", "id": req.Str("id")}
	if from := req.Str("from"); from != "" {
		f["to"] = from
	}
	if word != "" {
		f["ok"], f["error"] = false, word
	} else {
		f["ok"], f["result"] = true, result
	}
	r.mu.Lock()
	ws := r.ws
	r.mu.Unlock()
	if ws != nil {
		b, _ := json.Marshal(f)
		ws.Write(r.ctx, websocket.MessageText, b)
	}
}

// Close — закрыть связь с причиной и дождаться своих горутин.
func (r *Relay) Close() {
	r.cancel()
	r.mu.Lock()
	ws := r.ws
	r.mu.Unlock()
	if ws != nil {
		ws.Close(websocket.StatusNormalClosure, "keeper stop")
	}
	<-r.done
	r.opens.Wait()
}

// Reply — ответ Worker'а. Error — слово: своё или offline, timeout, disconnected, bad_frame.
type Reply struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// Post — кадр с пропуском key по адресу url; ответ — reply телом. Предел wait; отмена ctx — disconnected. Ответ без тела — ok.
func Post(ctx context.Context, url, key string, f Frame, wait time.Duration) Reply {
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	body := Frame{"key": key}
	for k, v := range f {
		body[k] = v
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return Reply{Error: "offline"}
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return Reply{Error: "timeout"}
		case ctx.Err() != nil:
			return Reply{Error: "disconnected"}
		}
		return Reply{Error: "offline"}
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNoContent {
		return Reply{OK: true}
	}
	var r Reply
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		return Reply{Error: "bad_frame"}
	}
	return r
}
