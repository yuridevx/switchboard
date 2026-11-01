package main

// Связь keeper с рацией: вебсокет к relay ключом keeper.<машина>, hello, запросы с id и reply, кадры.
// Тот же протокол и те же паузы, что у клиента relay в Host: ping раз в 30 с, нет pong к следующему —
// соединение мёртвое; переподключение с паузой от 1 с, вдвое до 60 с.
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// relayProto — версия контракта relay в hello.
const relayProto = 1

var errDisconnected = errors.New("disconnected")

// frameMsg — кадр рации: поля конверта и всё остальное.
type frameMsg map[string]any

func (f frameMsg) str(k string) string { s, _ := f[k].(string); return s }

type reply struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// radio — клиент рации keeper.
type radio struct {
	url, key string
	pingMs   time.Duration
	pause0   time.Duration
	pauseMax time.Duration
	onOpen   func()
	onFrame  func(frameMsg)
	onState  func(open bool, why string)

	mu      sync.Mutex
	ws      *websocket.Conn
	waiting map[string]chan reply
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
}

func newRadio(url, key string) *radio {
	ctx, cancel := context.WithCancel(context.Background())
	return &radio{url: url, key: key, pingMs: 30 * time.Second, pause0: time.Second, pauseMax: time.Minute,
		waiting: map[string]chan reply{}, ctx: ctx, cancel: cancel, done: make(chan struct{})}
}

// run — держать связь до close.
func (r *radio) run() {
	defer close(r.done)
	pause := r.pause0
	for r.ctx.Err() == nil {
		opened, why := r.session()
		if r.onState != nil {
			r.onState(false, why)
		}
		if opened {
			pause = r.pause0
		}
		select {
		case <-r.ctx.Done():
			return
		case <-time.After(pause):
		}
		pause *= 2
		if pause > r.pauseMax {
			pause = r.pauseMax
		}
	}
}

// session — одно соединение: hello, чтение до обрыва. opened — hello был принят.
func (r *radio) session() (opened bool, why string) {
	ctx, cancel := context.WithTimeout(r.ctx, 20*time.Second)
	ws, _, err := websocket.Dial(ctx, r.url, nil)
	cancel()
	if err != nil {
		return false, "dial: " + err.Error()
	}
	ws.SetReadLimit(16 << 20)
	hello, _ := json.Marshal(map[string]any{"type": "hello", "key": r.key, "proto": relayProto})
	if err := ws.Write(r.ctx, websocket.MessageText, hello); err != nil {
		ws.CloseNow()
		return false, "hello: " + err.Error()
	}
	r.mu.Lock()
	r.ws = ws
	r.mu.Unlock()
	pong := make(chan struct{}, 1)
	stop := make(chan struct{})
	go func() {
		t := time.NewTicker(r.pingMs)
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
	}()
	defer func() {
		close(stop)
		r.mu.Lock()
		r.ws = nil
		w := r.waiting
		r.waiting = map[string]chan reply{}
		r.mu.Unlock()
		for _, c := range w {
			c <- reply{Error: "disconnected"}
		}
		ws.CloseNow()
	}()
	first := true
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
		var f frameMsg
		if json.Unmarshal(b, &f) != nil {
			continue
		}
		// relay отвечает roster на принятый hello; keeper в roster не входит, но roster — знак, что hello принят
		if first {
			first = false
			opened = true
			if r.onState != nil {
				r.onState(true, "")
			}
			if r.onOpen != nil {
				go r.onOpen()
			}
		}
		if f.str("type") == "reply" {
			id := f.str("id")
			r.mu.Lock()
			c := r.waiting[id]
			delete(r.waiting, id)
			r.mu.Unlock()
			if c != nil {
				var rp reply
				json.Unmarshal(b, &rp)
				c <- rp
			}
			continue
		}
		if f.str("type") == "roster" {
			continue
		}
		if r.onFrame != nil {
			go r.onFrame(f)
		}
	}
}

// send — кадр без ответа; нет связи — errDisconnected.
func (r *radio) send(f frameMsg) error {
	r.mu.Lock()
	ws := r.ws
	r.mu.Unlock()
	if ws == nil {
		return errDisconnected
	}
	b, _ := json.Marshal(f)
	return ws.Write(r.ctx, websocket.MessageText, b)
}

// request — кадр с id и ожидание reply; обрыв — error "disconnected".
func (r *radio) request(f frameMsg, timeout time.Duration) reply {
	id := newID()
	f["id"] = id
	c := make(chan reply, 1)
	r.mu.Lock()
	if r.ws == nil {
		r.mu.Unlock()
		return reply{Error: "disconnected"}
	}
	r.waiting[id] = c
	r.mu.Unlock()
	if err := r.send(f); err != nil {
		r.mu.Lock()
		delete(r.waiting, id)
		r.mu.Unlock()
		return reply{Error: "disconnected"}
	}
	select {
	case rp := <-c:
		return rp
	case <-time.After(timeout):
		r.mu.Lock()
		delete(r.waiting, id)
		r.mu.Unlock()
		return reply{Error: "timeout"}
	case <-r.ctx.Done():
		return reply{Error: "disconnected"}
	}
}

// answer — ответ на чужой запрос.
func (r *radio) answer(req frameMsg, result any, word string) {
	f := frameMsg{"type": "reply", "id": req.str("id")}
	if from := req.str("from"); from != "" {
		f["to"] = from
	}
	if word != "" {
		f["ok"] = false
		f["error"] = word
	} else {
		f["ok"] = true
		if result != nil {
			f["result"] = result
		}
	}
	r.send(f)
}

func (r *radio) close() {
	r.cancel()
	r.mu.Lock()
	ws := r.ws
	r.mu.Unlock()
	if ws != nil {
		ws.Close(websocket.StatusNormalClosure, "keeper stop")
	}
	<-r.done
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
