package main

// Связь Keeper с флотом — один адрес. Соединение: wss <адрес>/m/<флот>/<машина>, первым — hello { proto, key, role: "keeper" }; ping —
// средствами WebSocket, нет ответа к следующему — соединение мёртвое; обрыв — новое подключение с паузой от первой вдвое до предела,
// после живого соединения — снова с первой. Кадры: plan.changed — «спроси план»; keeper.state — ответ состоянием. Запросы: POST <адрес>/call
// с пропуском машины — builds.plan при каждом подключении и по plan.changed, ledger.add — записи журнала флота.
// Пропуск не принят (bad_key, revoked, forbidden, proto) — связь останавливается: Keeper исполняет сохранённый план и не стучится.
import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	dialWait  = 20 * time.Second // подключение к флоту
	callWait  = 10 * time.Second // запись журнала флота
	writeWait = 10 * time.Second // запись в соединение: не вышло — соединение закрыто, keeper подключается снова
	frameMax  = 32 << 20         // предел кадра
	proto     = 2
)

// barWords — слова, после которых соединяться бессмысленно.
var barWords = map[string]bool{"bad_key": true, "revoked": true, "forbidden": true, "proto": true}

// bar — пропуск не принят: связь останавливается, одна строка журнала.
func (k *Keeper) bar(word, why string) {
	k.barOnce.Do(func() {
		k.fault("link_stopped", "word", word, "why", "пропуск не принят — исполняю сохранённый план без связи: "+why)
		close(k.barred)
	})
}

func (k *Keeper) isBarred() bool {
	select {
	case <-k.barred:
		return true
	default:
		return false
	}
}

func (k *Keeper) link() {
	defer k.links.Done()
	if k.c.Base == "" || k.key == "" || k.machine == "" {
		k.fault("link_stopped", "why", "нет адреса флота (keeper.json: base, machine) или machine.key — исполняю сохранённый план без связи")
		return
	}
	url := strings.TrimSuffix(k.c.Base, "/") + "/m/" + k.fleet + "/" + k.machine
	url = "ws" + strings.TrimPrefix(url, "http")
	pause := k.o.PauseFirst
	for k.ctx.Err() == nil && !k.isBarred() {
		alive, why := k.session(url)
		k.note("link_closed", "why", why)
		if alive {
			pause = k.o.PauseFirst
		}
		select {
		case <-k.ctx.Done():
		case <-k.barred:
		case <-time.After(pause):
		}
		pause = min(pause*2, k.o.PauseMax)
	}
}

// session — одно соединение с флотом; alive — соединение жило: дошёл кадр или ответ на ping.
func (k *Keeper) session(url string) (alive bool, why string) {
	ctx, cancel := context.WithCancel(k.ctx)
	defer cancel()
	dctx, dcancel := context.WithTimeout(ctx, dialWait)
	defer dcancel()
	c, resp, err := websocket.Dial(dctx, url, nil)
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			k.bar("bad_key", fmt.Sprintf("флот ответил %d на подключение", resp.StatusCode))
		}
		return false, "dial: " + err.Error()
	}
	defer c.CloseNow()
	c.SetReadLimit(frameMax)
	hello, _ := json.Marshal(map[string]any{"type": "hello", "proto": proto, "key": k.key, "role": "keeper"})
	if err := c.Write(dctx, websocket.MessageText, hello); err != nil {
		return false, "hello: " + err.Error()
	}
	k.note("link_open", "url", url)
	k.links.Add(1)
	go func() { defer k.links.Done(); k.askPlan(ctx) }()
	// чтение — не на контексте остановки: отмена рвёт соединение, а штатная остановка закрывает его кадром с причиной
	rctx, rcancel := context.WithCancel(context.Background())
	defer rcancel()
	go func() {
		select {
		case <-k.ctx.Done():
			c.Close(websocket.StatusNormalClosure, "keeper_stop")
		case <-k.barred:
			c.Close(websocket.StatusNormalClosure, "barred")
		case <-rctx.Done():
		}
	}()
	dead := make(chan struct{})
	ponged := make(chan struct{}, 1)
	go func() {
		t := time.NewTicker(k.o.Ping)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			pctx, pcancel := context.WithTimeout(ctx, k.o.Ping)
			err := c.Ping(pctx)
			pcancel()
			if err != nil {
				if ctx.Err() == nil {
					close(dead)
					c.CloseNow()
				}
				return
			}
			select {
			case ponged <- struct{}{}:
			default:
			}
		}
	}()
	for {
		_, b, err := c.Read(rctx)
		if err != nil {
			select {
			case <-ponged:
				alive = true
			default:
			}
			select {
			case <-dead:
				return alive, fmt.Sprintf("нет ответа на ping за %v — соединение мёртвое", k.o.Ping)
			default:
			}
			if k.ctx.Err() != nil {
				return true, "keeper остановлен"
			}
			var ce websocket.CloseError
			if errors.As(err, &ce) && barWords[ce.Reason] {
				k.bar(ce.Reason, "флот закрыл соединение словом "+ce.Reason)
			}
			return alive, err.Error()
		}
		alive = true
		k.frame(ctx, c, b)
	}
}

// send — кадр во флот за предел записи.
func send(ctx context.Context, c *websocket.Conn, b []byte) {
	wctx, cancel := context.WithTimeout(ctx, writeWait)
	defer cancel()
	c.Write(wctx, websocket.MessageText, b)
}

// frame — кадр от флота: plan.changed — спросить план; keeper.state — ответ состоянием; незнакомый запрос — отказ словом.
func (k *Keeper) frame(ctx context.Context, c *websocket.Conn, b []byte) {
	t0 := time.Now()
	var f struct{ Type, ID, From, Trace string }
	json.Unmarshal(b, &f)
	reply := func(r map[string]any) {
		ms := time.Since(t0).Milliseconds()
		r["type"], r["id"] = "reply", f.ID
		r["spans"] = []map[string]any{{"part": "keeper", "ms": ms}}
		if f.Trace != "" {
			r["trace"] = f.Trace
		}
		out, _ := json.Marshal(r)
		send(ctx, c, out)
		kv := []any{"type", f.Type, "from", f.From, "ms", ms, "ok", r["ok"], "trace", f.Trace}
		if w, _ := r["error"].(string); w != "" {
			kv = append(kv, "word", w)
		}
		k.note("request", kv...)
	}
	switch f.Type {
	case "plan.changed":
		k.links.Add(1)
		go func() { defer k.links.Done(); k.askPlan(ctx) }()
	case "keeper.state":
		if f.ID != "" {
			reply(map[string]any{"ok": true, "result": k.State()})
		}
	case "reply", "":
	default:
		if f.ID != "" {
			reply(map[string]any{"ok": false, "error": "unknown_request", "why": "Keeper не знает запроса " + f.Type})
		}
	}
}

// planOS — ОС для builds.plan.
func planOS() string { return runtime.GOOS }

// askPlan — вопрос флоту о плане: ответ — план, null (сборка не назначена), отказ словом или молчание за предел; соединение не трогается.
func (k *Keeper) askPlan(ctx context.Context) {
	pctx, cancel := context.WithTimeout(ctx, k.o.PlanWait)
	defer cancel()
	var r reply
	trace := "t" + newID()
	err := k.post(pctx, map[string]any{"type": "builds.plan", "id": "r" + newID(), "trace": trace, "os": planOS(), "arch": runtime.GOARCH}, &r)
	var p *plan
	switch {
	case ctx.Err() != nil:
	case pctx.Err() == context.DeadlineExceeded:
		k.warn("plan_refused", "word", "timeout", "why", fmt.Sprintf("builds.plan не ответил за %v", k.o.PlanWait), "trace", trace)
	case err != nil:
		k.warn("plan_refused", "word", "offline", "why", "builds.plan не ответил: "+err.Error(), "trace", trace)
	case !r.OK:
		k.warn("plan_refused", "word", r.Error, "why", "builds.plan: "+r.Error+" "+r.Why, "trace", trace)
		if barWords[r.Error] {
			k.bar(r.Error, "builds.plan: "+r.Error)
		}
	case json.Unmarshal(r.Result, &p) != nil:
		k.warn("plan_refused", "word", "bad_frame", "why", "ответ builds.plan — не план: "+string(r.Result), "trace", trace)
	case p == nil:
		k.note("plan_none", "why", "сборка флоту не назначена", "trace", trace)
	case p.Build <= 0:
		k.warn("plan_refused", "word", "bad_frame", "why", "план без номера сборки", "trace", trace)
	default:
		k.offer(*p)
	}
}

// ledger — запись журнала флота своей горутиной: актор её не ждёт; не дошла — строкой в журнале машины. Остановка ждёт её до предела
// запроса: последняя запись перед выходом (подмена себя) доходит.
func (k *Keeper) ledger(what, text string, data map[string]any) {
	if k.c.Base == "" || k.key == "" || k.isBarred() {
		k.note("ledger", "what", what, "why", "нет связи с флотом: "+text)
		return
	}
	k.links.Add(1)
	go func() {
		defer k.links.Done()
		ctx, cancel := context.WithTimeout(context.Background(), callWait)
		defer cancel()
		var r reply
		f := map[string]any{"type": "ledger.add", "id": "r" + newID(), "trace": "t" + newID(), "what": what, "machine": k.machine, "text": text, "data": data}
		if err := k.post(ctx, f, &r); err != nil {
			k.note("ledger", "what", what, "why", "offline: "+text+": "+err.Error())
		} else if !r.OK {
			k.note("ledger", "what", what, "why", r.Error+": "+text)
		}
	}()
}

// reply — ответ входа флота.
type reply struct {
	OK     bool            `json:"ok"`
	Error  string          `json:"error"`
	Why    string          `json:"why"`
	Result json.RawMessage `json:"result"`
}

// post — запрос флоту пропуском машины.
func (k *Keeper) post(ctx context.Context, f map[string]any, out *reply) error {
	return postCall(ctx, k.c.Base, k.key, f, out)
}

// postCall — кадр на <адрес>/call; key пуст — без пропуска (приём приглашения). Ответ входа — кадр reply и при коде ошибки.
func postCall(ctx context.Context, base, key string, f map[string]any, out *reply) error {
	b, _ := json.Marshal(f)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/call", bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if key != "" {
		req.Header.Set("authorization", "Bearer "+key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("вход ответил не кадром, HTTP %d", resp.StatusCode)
	}
	return nil
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
