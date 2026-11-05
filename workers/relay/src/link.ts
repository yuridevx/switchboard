// Клиент relay: одно соединение с объектом машины — hello, запросы с ожиданием reply, ping, переподключение по паузе.
import { CALL_MS, READ_MS, TOO_LARGE, fail, hostOf, isReply, oversize, parseFrame, type Frame, type Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";

/** Версия контракта relay в hello. */
export const PROTO = 1;

const PING_MS = 30_000;

export type LinkState = "connecting" | "open" | "closed" | "stopped";

export type WsLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: any) => void): void;
};
export type WsCtor = new (url: string) => WsLike;

export type LinkOptions = {
  url: string;
  key: string;
  /** поля hello сверх конверта; спрашивается на каждом подключении */
  hello?: () => Record<string, unknown>;
  onFrame?: (f: Frame) => void;
  /** retryAt — у closed: когда следующая попытка, мс */
  onState?: (state: LinkState, why?: string, retryAt?: number) => void;
  WebSocket?: WsCtor;
  requestMs?: number;
  pingMs?: number;
  pauseMs?: number;
  maxPauseMs?: number;
};

export type Sent = { ok: true } | { ok: false; error: string; bytes?: number };

export type Link = {
  readonly state: LinkState;
  /** последний известный roster объекта */
  readonly roster: Roster | null;
  /** Не бросает: отказ — reply с ok: false. read — запрос только читает, предел короче. */
  request(f: Frame, read?: boolean): Promise<Reply>;
  send(f: Frame): Sent;
  /** Браузер и Node принимают только код 1000 или 3000–4999. */
  close(code?: number, reason?: string): void;
};

const idPrefix = Math.random().toString(36).slice(2, 8);
let idCount = 0;
export const newId = () => `${idPrefix}-${++idCount}`;

/** Пауза между попытками: удваивается до предела. Одно правило для соединений и списка машин. */
export function backoff(pauseMs = 1000, maxMs = 60_000) {
  let next = pauseMs;
  return {
    take() {
      const p = next;
      next = Math.min(next * 2, maxMs);
      return p;
    },
    reset() {
      next = pauseMs;
    },
  };
}

/** Метка адресата запроса в roster: since его машины или адрес гостя; undefined — ответ или offline даст relay. */
function presence(r: Roster | null, f: Frame): unknown {
  const machine = hostOf(f);
  if (machine) return r?.machines.find((m) => m.machine === machine)?.since;
  return typeof f.to === "string" && r?.clients.includes(f.to) ? f.to : undefined;
}

type Waiter = { done(r: Reply): void; timer: ReturnType<typeof setTimeout>; f: Frame; seen: unknown };

/** Отказ, после которого подключаться снова незачем: пропуск, контракт или вытеснение. gate_unavailable — обычный обрыв. */
const isFinal = (code: number, reason: string) => reason === "replaced" || (code === 1008 && reason !== "gate_unavailable");

export function link(o: LinkOptions): Link {
  const WS = o.WebSocket ?? (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket;
  if (!WS) throw new Error("link: нет WebSocket — передайте options.WebSocket");
  const requestMs = o.requestMs ?? CALL_MS;
  const pause = backoff(o.pauseMs, o.maxPauseMs);
  const waiting = new Map<string, Waiter>();
  let state: LinkState = "connecting";
  let roster: Roster | null = null;
  let ws: WsLike | null = null;
  let stopTimers = () => {};
  let retry: ReturnType<typeof setTimeout> | undefined;

  function setState(next: LinkState, why?: string, retryAt?: number) {
    state = next;
    o.onState?.(next, why, retryAt);
  }

  function settle(id: string, r: Reply): boolean {
    const w = waiting.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    waiting.delete(id);
    w.done(r);
    return true;
  }

  /** Соединения больше нет: ждущие узнают сразу, closed подключится снова по паузе. */
  function end(next: "closed" | "stopped", why: string) {
    stopTimers();
    ws = null;
    for (const id of waiting.keys()) settle(id, fail(id, "disconnected"));
    if (next === "stopped") return setState(next, why);
    const p = pause.take();
    retry = setTimeout(() => {
      setState("connecting");
      connect();
    }, p);
    setState(next, why, Date.now() + p);
  }

  function connect() {
    const sock = new WS!(o.url);
    ws = sock;
    let alive = true;
    let ping: ReturnType<typeof setInterval> | undefined;
    const abandon = (why: string) => {
      sock.close(4000, why);
      end("closed", why);
    };
    const noRoster = setTimeout(() => abandon("no_roster"), requestMs);
    stopTimers = () => {
      clearTimeout(noRoster);
      if (ping) clearInterval(ping);
    };
    /** Брошенный сокет больше не слушаем. */
    const live = (fn: (ev: any) => void) => (ev: any) => {
      if (sock === ws) fn(ev);
    };

    sock.addEventListener(
      "open",
      live(() => {
        sock.send(JSON.stringify({ ...o.hello?.(), type: "hello", key: o.key, proto: PROTO }));
        ping = setInterval(() => {
          if (!alive) return abandon("no_pong");
          alive = false;
          sock.send("ping");
        }, o.pingMs ?? PING_MS);
      }),
    );

    sock.addEventListener(
      "message",
      live((ev) => {
        const text = String(ev.data);
        if (text === "pong") {
          alive = true;
          return;
        }
        const f = parseFrame(text);
        if (!f || (isReply(f) && settle(f.id, f))) return;
        if (f.type === "roster") {
          roster = f as unknown as Roster;
          // адресат запроса ушёл или переподключился: ответа он уже не даст
          for (const [id, w] of waiting) if (w.seen !== undefined && presence(roster, w.f) !== w.seen) settle(id, fail(id, "disconnected"));
          if (state !== "open") {
            clearTimeout(noRoster);
            pause.reset();
            setState("open");
          }
        }
        o.onFrame?.(f);
      }),
    );

    sock.addEventListener(
      "close",
      live((ev) => (isFinal(ev.code, ev.reason) ? end("stopped", ev.reason) : end("closed", ev.reason || String(ev.code)))),
    );
  }

  function send(f: Frame): Sent {
    if (state !== "open") return { ok: false, error: "disconnected" };
    const text = JSON.stringify(f);
    const bytes = oversize(text);
    if (bytes === null) {
      ws!.send(text);
      return { ok: true };
    }
    if (!isReply(f)) return { ok: false, error: TOO_LARGE, bytes };
    // ответ не влез: спросивший ждёт — получает отказ вместо результата
    ws!.send(JSON.stringify({ ...fail(f.id, TOO_LARGE), bytes, to: f.to }));
    return { ok: true };
  }

  connect();

  return {
    get state() {
      return state;
    },
    get roster() {
      return roster;
    },
    send,
    request(f, read = false) {
      const id = f.id ?? newId();
      return new Promise((done) => {
        const timer = setTimeout(() => settle(id, fail(id, "timeout")), read ? Math.min(READ_MS, requestMs) : requestMs);
        waiting.set(id, { done, timer, f, seen: presence(roster, f) });
        const sent = send({ ...f, id });
        if (!sent.ok) settle(id, { type: "reply", id, ...sent });
      });
    },
    close(code = 1000, reason = "closing") {
      if (state === "stopped") return;
      if (retry) clearTimeout(retry);
      ws?.close(code, reason);
      end("stopped", reason);
    },
  };
}
