// Клиент одного соединения с relay: hello, запросы с ожиданием reply, ping, переподключение.
import { CALL_MS, READ_MS, TOO_LARGE, fail, hostOf, isReply, oversize, parseFrame, type Frame, type Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";

/** Версия контракта relay в hello. */
export const PROTO = 1;

const PING_MS = 30_000;
const tag = Math.random().toString(36).slice(2, 8);
let seq = 0;

/** Свой на вкладку и соединение: ответ устройству приходит во все его соединения. */
export const newId = () => `${tag}-${++seq}`;

/** Следующая пауза попытки: одно правило для соединений и списка машин. */
export const nextPause = (ms: number) => Math.min(ms * 2, 60_000);

export type LinkState = "connecting" | "open" | "closed" | "stopped";

export type WsLike = {
  readyState: number;
  addEventListener(type: "open" | "message" | "close" | "error", fn: (ev: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
export type WsCtor = new (url: string) => WsLike;

export type Sent = { ok: true } | { ok: false; error: string; bytes?: number };

export type Link = {
  readonly state: LinkState;
  readonly roster: Roster | null;
  request(f: Omit<Frame, "id"> & { id?: string }, read?: boolean): Promise<Reply>;
  send(f: Frame): Sent;
  close(code?: number, reason?: string): void;
};

export type LinkOptions = {
  url: string;
  key: string;
  hello?: () => Record<string, unknown>;
  onFrame?: (f: Frame) => void;
  /** closed — с временем следующей попытки */
  onState?: (state: LinkState, why?: string, retryAt?: number) => void;
  WebSocket?: WsCtor;
  /** первая пауза переподключения, дальше вдвое */
  pauseMs?: number;
};

type Waiter = { frame: Frame; seen: unknown; done(r: Reply): void; timer: ReturnType<typeof setTimeout> };

/** Как адресат выглядит в roster: since его машины или адрес гостя; undefined — ответ или offline даст relay. */
function presence(r: Roster, f: Frame): unknown {
  const machine = hostOf(f);
  if (machine) return r.machines.find((m) => m.machine === machine)?.since;
  return r.clients.find((c) => c === f.to);
}

export function link(o: LinkOptions): Link {
  const firstPause = o.pauseMs ?? 1000;
  const waiting = new Map<string, Waiter>();
  let pause = firstPause;
  let state: LinkState = "connecting";
  let roster: Roster | null = null;
  let ws: WsLike | null = null;
  let alive = true;
  let retry: ReturnType<typeof setTimeout>;
  let noRoster: ReturnType<typeof setTimeout>;
  let beat: ReturnType<typeof setInterval>;

  function become(next: LinkState, why?: string, retryAt?: number) {
    state = next;
    o.onState?.(next, why, retryAt);
  }

  function finish(id: string, r: Reply): boolean {
    const w = waiting.get(id);
    if (!w) return false;
    waiting.delete(id);
    clearTimeout(w.timer);
    w.done(r);
    return true;
  }

  /** Сокет больше не наш: его поздние события не считаются. */
  function detach() {
    clearTimeout(noRoster);
    clearInterval(beat);
    const was = ws;
    ws = null;
    for (const id of [...waiting.keys()]) finish(id, fail(id, "disconnected"));
    return was;
  }

  function broken(why: string) {
    const was = detach();
    const retryAt = Date.now() + pause;
    retry = setTimeout(() => {
      become("connecting");
      connect();
    }, pause);
    pause = nextPause(pause);
    become("closed", why, retryAt);
    return was;
  }

  const cut = (why: string) => broken(why)?.close(4000, why);

  function onClose(code: number, reason: string) {
    if ((code === 1008 && reason !== "gate_unavailable") || reason === "replaced") {
      detach();
      become("stopped", reason);
    } else broken(reason || String(code));
  }

  function onMessage(text: string) {
    if (text === "pong") {
      alive = true;
      return;
    }
    const f = parseFrame(text);
    if (!f) return;
    if (isReply(f) && finish(f.id, f)) return;
    if (f.type === "roster") {
      const now = (roster = f as unknown as Roster);
      clearTimeout(noRoster);
      pause = firstPause;
      if (state !== "open") become("open");
      for (const [id, w] of waiting) if (w.seen !== undefined && presence(now, w.frame) !== w.seen) finish(id, fail(id, "disconnected"));
    }
    o.onFrame?.(f);
  }

  function connect() {
    const s = new (o.WebSocket ?? (globalThis.WebSocket as unknown as WsCtor))(o.url);
    ws = s;
    alive = true;
    s.addEventListener("open", () => {
      if (s !== ws) return;
      s.send(JSON.stringify({ ...o.hello?.(), type: "hello", key: o.key, proto: PROTO }));
      noRoster = setTimeout(() => cut("no_roster"), CALL_MS);
      beat = setInterval(() => {
        if (!alive) return cut("no_pong");
        alive = false;
        s.send("ping");
      }, PING_MS);
    });
    s.addEventListener("message", (e) => void (s === ws && onMessage(String(e.data))));
    s.addEventListener("close", (e) => void (s === ws && onClose(e.code, e.reason)));
  }

  function send(f: Frame): Sent {
    if (state !== "open") return { ok: false, error: "disconnected" };
    const text = JSON.stringify(f);
    const bytes = oversize(text);
    if (bytes === null) {
      ws!.send(text);
      return { ok: true };
    }
    if (f.type !== "reply") return { ok: false, error: TOO_LARGE, bytes };
    // спросивший ждёт: вместо ответа — отказ
    ws!.send(JSON.stringify({ ...fail(f.id!, TOO_LARGE), to: f.to, bytes }));
    return { ok: true };
  }

  function request(f: Omit<Frame, "id"> & { id?: string }, read = false): Promise<Reply> {
    const id = f.id ?? newId();
    const frame = { ...f, id } as Frame;
    const sent = send(frame);
    if (!sent.ok) return Promise.resolve(Object.assign(fail(id, sent.error), { bytes: sent.bytes }));
    return new Promise((done) => {
      const timer = setTimeout(() => finish(id, fail(id, "timeout")), read ? READ_MS : CALL_MS);
      waiting.set(id, { frame, seen: presence(roster!, frame), done, timer });
    });
  }

  function close(code = 1000, reason = "closing") {
    clearTimeout(retry);
    const was = detach();
    if (state !== "stopped") become("stopped", reason);
    was?.close(code, reason);
  }

  connect();
  return {
    get state() {
      return state;
    },
    get roster() {
      return roster;
    },
    request,
    send,
    close,
  };
}
