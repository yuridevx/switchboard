package main

// Прямой запрос к Worker'у флота: POST кадра с пропуском машины, ответ — reply телом (обёртка входа gate).
// Предел — у каждого запроса; остановка keeper обрывает ждущий запрос словом disconnected.
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

// post — кадр f с пропуском key по адресу url; ответ — reply. Нет ответа за wait — timeout, quit закрыт — disconnected,
// сеть — offline. Без id ответ без тела — ok.
func post(url, key string, f frameMsg, wait time.Duration, quit <-chan struct{}) reply {
	if url == "" {
		return reply{Error: "offline"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	go func() {
		select {
		case <-quit:
			cancel()
		case <-ctx.Done():
		}
	}()
	body := frameMsg{"key": key}
	for k, v := range f {
		body[k] = v
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return reply{Error: "offline"}
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return reply{Error: "timeout"}
		case ctx.Err() != nil:
			return reply{Error: "disconnected"}
		}
		return reply{Error: "offline"}
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNoContent {
		return reply{OK: true}
	}
	var r reply
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		return reply{Error: "bad_frame"}
	}
	return r
}
