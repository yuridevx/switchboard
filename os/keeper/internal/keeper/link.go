package keeper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"switchboard/keeper/internal/machine"
)

const (
	dialWait  = 20 * time.Second
	writeWait = 10 * time.Second
	readLimit = 16 << 20
)

// linkLoop — соединение с relay своей машины. Те же протокол и паузы, что у клиента relay в Host: оборвалось — снова, от первой паузы вдвое до предела;
// сбрасывает паузу только принятый hello.
func (k *Keeper) linkLoop() {
	defer k.wg.Done()
	url := strings.TrimRight(k.conf.Workers["relay"], "/")
	if strings.HasPrefix(url, "http") {
		url = "ws" + strings.TrimPrefix(url, "http")
	}
	if url == "" || k.name == "" {
		k.stopLine("keeper", "relay", "в keeper.json нет адреса relay (workers.relay) или нет machine.key — исполняю сохранённый план без связи")
		return
	}
	pause := k.o.PauseFirst
	for !k.leaving() {
		accepted, err := k.session(url + "/m/" + k.name)
		if k.leaving() {
			return
		}
		k.note("keeper", "relay_closed", "why", err.Error())
		if accepted {
			pause = k.o.PauseFirst
		}
		select {
		case <-time.After(pause):
		case <-k.ctx.Done():
			return
		}
		if !accepted {
			pause = min(pause*2, k.o.PauseMax)
		}
	}
}

// session — одно соединение: hello; relay отвечает на него roster, первым кадром, — вопрос о плане; кадры до обрыва. Нет pong к следующему ping — соединение мёртвое.
func (k *Keeper) session(url string) (accepted bool, err error) {
	dial, cancel := context.WithTimeout(k.ctx, dialWait)
	defer cancel()
	c, _, err := websocket.Dial(dial, url, nil)
	if err != nil {
		return false, fmt.Errorf("dial: %w", err)
	}
	defer c.CloseNow()
	c.SetReadLimit(readLimit)
	send := func(b []byte) error {
		ctx, cancel := context.WithTimeout(k.ctx, writeWait)
		defer cancel()
		return c.Write(ctx, websocket.MessageText, b)
	}
	if err := send(must(map[string]any{"type": "hello", "key": k.key, "proto": 1, "part": "keeper"})); err != nil {
		return false, fmt.Errorf("hello: %w", err)
	}

	sess, end := context.WithCancel(k.ctx)
	var work sync.WaitGroup
	defer work.Wait()
	defer end()
	var waiting, dead atomic.Bool
	work.Add(1)
	go func() {
		defer work.Done()
		t := time.NewTicker(k.o.Ping)
		defer t.Stop()
		for {
			select {
			case <-sess.Done():
				if k.leaving() {
					c.Close(websocket.StatusNormalClosure, "keeper stop")
				}
				return
			case <-t.C:
				if waiting.Swap(true) {
					dead.Store(true)
					c.CloseNow()
					return
				}
				send([]byte("ping"))
			}
		}
	}()

	for {
		_, b, err := c.Read(context.Background())
		if err != nil {
			if dead.Load() {
				return accepted, errors.New("no_pong")
			}
			return accepted, err
		}
		if string(b) == "pong" {
			waiting.Store(false)
			continue
		}
		var f struct {
			Type, ID, From string
		}
		if json.Unmarshal(b, &f) != nil {
			continue
		}
		switch f.Type {
		case "roster":
			if !accepted {
				accepted = true
				k.note("keeper", "relay_open")
				work.Add(1)
				go func() { defer work.Done(); k.askPlan(sess) }()
			}
		case "reply":
		case "releases.plan":
			k.planFrame(b, f.From)
		case "keeper.state":
			send(must(map[string]any{"type": "reply", "id": f.ID, "ok": true, "result": k.State(), "to": f.From}))
		default:
			if f.ID != "" {
				send(must(map[string]any{"type": "reply", "id": f.ID, "ok": false, "error": "unknown_request", "to": f.From}))
			}
		}
	}
}

// planFrame — план кадром: только от «Выпусков», только v1. Конверт принадлежит протоколу и relay; строгость — к телу плана.
func (k *Keeper) planFrame(b []byte, from string) {
	if from != ".releases" {
		k.refuse("bad_from", "план не от .releases: "+from)
		return
	}
	var f struct {
		Plan
		Type, ID, To, From string
		V                  any
	}
	err := strict(b, &f)
	if err == nil && f.V != float64(1) {
		k.refuse("contract_mismatch", fmt.Sprintf("кадр releases.plan v %v — не v1", f.V))
		return
	}
	if err != nil {
		k.refuse("contract_mismatch", "кадр releases.plan — не план v1: "+err.Error())
		return
	}
	k.offer(&f.Plan)
}

// askPlan — при каждом подключении: план — POST «Выпускам» пропуском машины. Отказ или нет ответа — строка журнала, соединение не трогается: план придёт кадром
// при перемене или при следующем соединении.
func (k *Keeper) askPlan(sess context.Context) {
	url := k.conf.Workers["releases"]
	if url == "" {
		k.stopLine("keeper", "plan", "в keeper.json нет адреса «Выпусков» (workers.releases) — исполняю сохранённый план")
		return
	}
	ctx, cancel := context.WithTimeout(sess, k.o.PlanWait)
	defer cancel()
	var r struct {
		OK     bool            `json:"ok"`
		Error  string          `json:"error"`
		Result json.RawMessage `json:"result"`
	}
	err := machine.Post(ctx, url, map[string]any{"type": "releases.plan", "id": "plan", "v": 1, "to": ".releases", "key": k.key}, &r)
	if sess.Err() != nil {
		return
	}
	word := r.Error
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		word = "timeout"
	case err != nil:
		word = "offline"
	case r.OK:
		var pl Plan
		if err := strict(r.Result, &pl); err != nil {
			k.refuse("contract_mismatch", "ответ releases.plan — не план v1: "+err.Error())
			return
		}
		k.offer(&pl)
		return
	}
	k.refuse(word, "releases.plan не ответил: "+word)
}

// ledger — строка в журнал флота своей горутиной: цикл частей не ждёт; не дошла — только в журнал машины. Остановка ждёт её до предела запроса: последняя
// строка перед выходом (подмена себя) доходит.
func (k *Keeper) ledger(ev, text string) {
	url := k.conf.Workers["ledger"]
	if url == "" {
		k.note("keeper", "ledger", "event", ev, "why", "нет адреса журнала (workers.ledger): "+text)
		return
	}
	k.wg.Add(1)
	go func() {
		defer k.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), k.o.PlanWait)
		defer cancel()
		f := map[string]any{"type": "ledger.add", "v": 1, "to": ".ledger", "ev": ev, "text": text, "machine": k.name, "key": k.key}
		if err := machine.Post(ctx, url, f, nil); err != nil {
			k.note("keeper", "ledger", "event", ev, "why", "offline: "+text)
		}
	}()
}
