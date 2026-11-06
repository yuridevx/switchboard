package main

// Связь keeper с флотом. Relay своей машины: wss /m/<машина>, hello { key, proto, part: "keeper" }, roster — знак, что hello принят; ping
// текстом, нет pong к следующему — соединение мёртвое; обрыв — новое подключение с паузой от первой вдвое до предела, после принятого hello —
// снова с первой. Кадры: releases.plan от .releases — план; keeper.state — ответ состоянием. Worker'ы — POST по адресам из keeper.json с
// пропуском машины: releases.plan при каждом подключении, ledger.add — записи журнала флота.
import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	dialWait   = 20 * time.Second // подключение к relay и ответ roster на hello
	callWait   = 10 * time.Second // запись журнала флота
	writeWait  = 10 * time.Second // запись в relay: не вышло — соединение закрыто, keeper подключается снова
	frameMax   = 32 << 20         // предел кадра relay
	relayProto = 1
)

func (k *Keeper) link() {
	defer k.links.Done()
	relay := k.c.Workers["relay"]
	if k.c.Workers["releases"] == "" {
		k.fault("releases", "why", "в keeper.json нет адреса «Выпусков» (workers.releases) — исполняю сохранённый план")
	}
	if relay == "" || k.machine == "" {
		k.fault("relay", "why", "в keeper.json нет адреса relay (workers.relay) или нет machine.key — исполняю сохранённый план без связи")
		return
	}
	url := strings.TrimSuffix(relay, "/") + "/m/" + k.machine
	url = "ws" + strings.TrimPrefix(url, "http")
	pause := k.o.PauseFirst
	for k.ctx.Err() == nil {
		accepted, why := k.session(url)
		k.note("relay_closed", "why", why)
		if accepted {
			pause = k.o.PauseFirst
		}
		select {
		case <-k.ctx.Done():
		case <-time.After(pause):
		}
		pause = min(pause*2, k.o.PauseMax)
	}
}

// session — одно соединение с relay; accepted — hello принят.
func (k *Keeper) session(url string) (accepted bool, why string) {
	ctx, cancel := context.WithCancel(k.ctx)
	defer cancel()
	dctx, dcancel := context.WithTimeout(ctx, dialWait)
	defer dcancel()
	c, _, err := websocket.Dial(dctx, url, nil)
	if err != nil {
		return false, "dial: " + err.Error()
	}
	defer c.CloseNow()
	c.SetReadLimit(frameMax)
	hello, _ := json.Marshal(map[string]any{"type": "hello", "key": k.key, "proto": relayProto, "part": "keeper"})
	if err := c.Write(dctx, websocket.MessageText, hello); err != nil {
		return false, "hello: " + err.Error()
	}
	_, b, err := c.Read(dctx)
	if err != nil {
		return false, "hello не принят: " + err.Error()
	}
	var first struct{ Type string }
	if json.Unmarshal(b, &first); first.Type != "roster" {
		return false, "hello не принят: первый кадр " + string(b)
	}
	k.note("relay_open", "url", url)
	k.links.Add(1)
	go func() { defer k.links.Done(); k.askPlan(ctx) }()
	// чтение — не на контексте остановки: отмена рвёт соединение, а штатная остановка закрывает его кадром с причиной
	rctx, rcancel := context.WithCancel(context.Background())
	defer rcancel()
	go func() {
		select {
		case <-k.ctx.Done():
			c.Close(websocket.StatusNormalClosure, "keeper_stop")
		case <-rctx.Done():
		}
	}()
	var pong atomic.Bool
	pong.Store(true)
	dead := make(chan struct{})
	go func() {
		t := time.NewTicker(k.o.Ping)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			if !pong.Swap(false) {
				close(dead)
				c.CloseNow()
				return
			}
			send(ctx, c, []byte("ping"))
		}
	}()
	for {
		_, b, err := c.Read(rctx)
		if err != nil {
			select {
			case <-dead:
				return true, fmt.Sprintf("нет pong за %v — соединение мёртвое", k.o.Ping)
			default:
			}
			if k.ctx.Err() != nil {
				return true, "keeper остановлен"
			}
			return true, err.Error()
		}
		if string(b) == "pong" {
			pong.Store(true)
			continue
		}
		k.frame(ctx, c, b)
	}
}

// send — кадр в relay за предел записи.
func send(ctx context.Context, c *websocket.Conn, b []byte) {
	wctx, cancel := context.WithTimeout(ctx, writeWait)
	defer cancel()
	c.Write(wctx, websocket.MessageText, b)
}

// frame — кадр от relay: план от «Выпусков», запрос keeper.state; незнакомый запрос — отказ словом.
func (k *Keeper) frame(ctx context.Context, c *websocket.Conn, b []byte) {
	var f struct{ Type, ID, From string }
	json.Unmarshal(b, &f)
	reply := func(r map[string]any) {
		r["type"], r["id"], r["to"] = "reply", f.ID, f.From
		out, _ := json.Marshal(r)
		send(ctx, c, out)
	}
	switch f.Type {
	case "releases.plan":
		if f.From != ".releases" {
			k.refuse("bad_from", "план не от .releases: "+f.From)
			return
		}
		// конверт принадлежит протоколу и relay; строгость — к телу плана
		var env struct {
			V, Rev int
			Parts  json.RawMessage
		}
		json.Unmarshal(b, &env)
		p := plan{Rev: env.Rev}
		if env.V != 1 {
			k.refuse("contract_mismatch", fmt.Sprintf("кадр releases.plan v %d — не v1", env.V))
		} else if err := decodePlan(env.Parts, &p.Parts); err != nil {
			k.refuse("contract_mismatch", "кадр releases.plan — не план v1: "+err.Error())
		} else {
			k.offer(p)
		}
	case "keeper.state":
		reply(map[string]any{"ok": true, "result": k.State()})
	case "reply", "roster", "":
	default:
		if f.ID != "" {
			reply(map[string]any{"ok": false, "error": "unknown_request"})
		}
	}
}

// askPlan — вопрос о плане «Выпускам» при подключении: ответ — план, отказ словом или молчание за предел; соединение не трогается.
func (k *Keeper) askPlan(ctx context.Context) {
	if k.c.Workers["releases"] == "" {
		return
	}
	pctx, cancel := context.WithTimeout(ctx, k.o.PlanWait)
	defer cancel()
	var r struct {
		OK     bool
		Error  string
		Result json.RawMessage
	}
	err := k.post(pctx, "releases", map[string]any{"type": "releases.plan", "v": 1, "to": ".releases", "id": newID()}, &r)
	var p plan
	switch {
	case ctx.Err() != nil:
	case pctx.Err() == context.DeadlineExceeded:
		k.refuse("timeout", fmt.Sprintf("releases.plan не ответил за %v", k.o.PlanWait))
	case err != nil:
		k.refuse("offline", "releases.plan не ответил: "+err.Error())
	case !r.OK:
		k.refuse(r.Error, "releases.plan не ответил: "+r.Error)
	case decodePlan(r.Result, &p) != nil:
		k.refuse("contract_mismatch", fmt.Sprintf("ответ releases.plan — не план v1: %s", decodePlan(r.Result, &p)))
	default:
		k.offer(p)
	}
}

// ledger — запись журнала флота своей горутиной: цикл частей её не ждёт; не дошла — строкой в журнале машины. Остановка ждёт её до предела
// запроса: последняя запись перед выходом (подмена себя) доходит.
func (k *Keeper) ledger(ev, text string) {
	if k.c.Workers["ledger"] == "" {
		k.note("ledger", "event", ev, "why", "нет адреса журнала (workers.ledger): "+text)
		return
	}
	k.links.Add(1)
	go func() {
		defer k.links.Done()
		ctx, cancel := context.WithTimeout(context.Background(), callWait)
		defer cancel()
		if err := k.post(ctx, "ledger", map[string]any{"type": "ledger.add", "v": 1, "to": ".ledger", "ev": ev, "text": text, "machine": k.machine}, nil); err != nil {
			k.note("ledger", "event", ev, "why", "offline: "+text+": "+err.Error())
		}
	}()
}

// post — кадр Worker'у по адресу из keeper.json с пропуском машины; out — ответ, если нужен.
func (k *Keeper) post(ctx context.Context, worker string, f map[string]any, out any) error {
	return postWorker(ctx, k.c.Workers[worker], k.key, f, out)
}

func postWorker(ctx context.Context, url, key string, f map[string]any, out any) error {
	f["key"] = key
	b, _ := json.Marshal(f)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out) // отказ Worker'а — кадр со словом и при коде ошибки
	}
	if resp.StatusCode >= 300 {
		return errors.New(resp.Status)
	}
	return nil
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
