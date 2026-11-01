// Клиент link: соединение с relay по wss. Им пользуются ядро Host, веб-приложения и скрипты.
// Работает в Node 24 (глобальный WebSocket) и в браузере; в тестах WebSocket подставляется.
import { fail, isReply, kindOf, machineOf, oversize, parseFrame, serviceAddress, TOO_LARGE } from "@switchboard/protocol";
import type { Frame, Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";

/** Версия контракта relay, которую link шлёт в hello. */
export const PROTO = 1;

/**
 * Состояние связи:
 * connecting — сокет открывается или ждёт первого roster после hello;
 * open — hello принят (пришёл roster), запросы идут;
 * closed — оборвалось, ждёт паузу и переподключится сам;
 * stopped — больше не переподключается: close() или отказ relay
 *   (1008 bad_key, revoked, contract_mismatch, bad_from, bad_frame; 1000 replaced). Причина — в onState.
 */
export type LinkState = "connecting" | "open" | "closed" | "stopped";

/** То, что link берёт от WebSocket: подходит и браузерный, и Node 24, и подделка в тесте. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", fn: () => void): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code: number; reason: string }) => void): void;
}
export type WsCtor = new (url: string) => WsLike;

export type LinkOptions = {
  /** wss://switchboard.<subdomain>.workers.dev */
  url: string;
  /** ключ флота role.name.kid.sig — из stdin, переменной окружения или хранилища; не из argv */
  key: string;
  /** версия контракта relay; по умолчанию PROTO */
  proto?: number;
  /**
   * Поля hello сверх type, key, proto — зовётся на каждом подключении, чтобы hello нёс свежее:
   * Host — { sdk, contract, sessions }, клиент — обычно ничего.
   */
  hello?: () => Record<string, unknown>;
  /** Каждый входящий кадр, кроме ответов на свои запросы: roster (после того, как link его учёл), запросы, кадры с to. */
  onFrame?: (f: Frame) => void;
  /** Смена состояния; why — слово или причина закрытия. */
  onState?: (state: LinkState, why?: string) => void;
  /** Период ping, мс. Нет pong к следующему ping — соединение мёртвое: закрыть и переподключиться. По умолчанию 30 000. */
  pingMs?: number;
  /** Первая пауза переподключения, мс; растёт вдвое, сбрасывается после принятого hello. По умолчанию 1 000. */
  pauseMs?: number;
  /** Потолок паузы, мс. По умолчанию 60 000. */
  maxPauseMs?: number;
  /** Конструктор WebSocket; по умолчанию глобальный. */
  WebSocket?: WsCtor;
};

export interface Link {
  readonly state: LinkState;
  /** Последний roster от relay; null — ещё не было. */
  readonly roster: Roster | null;
  /**
   * Запрос: кадр с id (свой id link ставит сам, если его нет) → reply с тем же id.
   * Не бросает: отказ — reply { ok: false, error }. Очереди нет:
   * связи нет — сразу disconnected; связь оборвалась, пока ждали, — disconnected;
   * адресат (машина callsign/machine/to "@m" или имя клиента/участника в to) ушёл из roster
   * или его машина сменила since — disconnected. Таймера нет.
   * Кадр больше MAX_FRAME не уходит: сразу too_large { bytes } — relay порвал бы соединение всей машины.
   */
  request(f: Frame): Promise<Reply>;
  /**
   * Кадр без ожидания ответа; очереди нет. Связи нет — disconnected, кадр не ушёл.
   * Больше MAX_FRAME: ответ заменяется отказом too_large { bytes } тому же адресату и уходит; прочий кадр не уходит — too_large { bytes }.
   */
  send(f: Frame): { ok: true } | { ok: false; error: "disconnected" | "too_large"; bytes?: number };
  /**
   * Штатная остановка: ждущие — disconnected, сокет закрыт с кодом и причиной, переподключений нет.
   * Браузер и Node принимают только код 1000 или 3000–4999.
   */
  close(code?: number, reason?: string): void;
}

type Target = { machine: string } | { name: string } | null;
type Pending = { resolve: (r: Reply) => void; target: Target; since?: number; present: boolean };

/** Адресат запроса, чей уход из roster означает: ответа не будет. */
function targetOf(f: Frame): Target {
  if (typeof f.to === "string") {
    switch (kindOf(f.to)) {
      case "machine":
      case "session":
        return { machine: machineOf(f.to)! };
      case "service":
      case "device":
        return { name: f.to };
      default:
        // часть машины и пользователь в roster не видны: ответ или offline даст relay
        return null;
    }
  }
  if (f.to !== undefined) return null;
  if (typeof f.callsign === "string") {
    const m = machineOf(f.callsign);
    return m ? { machine: m } : null;
  }
  if (typeof f.machine === "string") return { machine: f.machine };
  return null;
}

function sinceOf(r: Roster | null, machine: string): number | undefined {
  return r?.machines.find((m) => m.machine === machine)?.since;
}

function hasName(r: Roster | null, name: string): boolean {
  return !!r && (r.clients.includes(name) || r.workers.some((w) => serviceAddress(w.name) === name));
}

/** Открыть связь с relay. Подключается сразу; дальше живёт сама до close() или отказа relay. */
export function link(o: LinkOptions): Link {
  const found = o.WebSocket ?? (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket;
  if (!found) throw new Error("link: нет WebSocket — передайте options.WebSocket");
  const Ws: WsCtor = found;
  const pingMs = o.pingMs ?? 30_000;
  const firstPause = o.pauseMs ?? 1_000;
  const maxPause = o.maxPauseMs ?? 60_000;
  // свой префикс id: два соединения с одним именем клиента получают ответы друг друга по to
  const prefix = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  let ws: WsLike | null = null;
  let state: LinkState = "connecting";
  let roster: Roster | null = null;
  let pause = firstPause;
  let waitingPong = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, Pending>();

  function setState(s: LinkState, why?: string) {
    if (state === s && why === undefined) return;
    state = s;
    o.onState?.(s, why);
  }

  function failAll() {
    const all = [...pending];
    pending.clear();
    for (const [id, p] of all) p.resolve(fail(id, "disconnected"));
  }

  function stopTimers() {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
    pingTimer = pauseTimer = undefined;
  }

  function connect() {
    setState("connecting");
    const sock = new Ws(o.url);
    ws = sock;
    waitingPong = false;
    sock.addEventListener("open", () => {
      if (ws !== sock) return;
      sock.send(JSON.stringify({ ...(o.hello?.() ?? {}), type: "hello", key: o.key, proto: o.proto ?? PROTO }));
      pingTimer = setInterval(() => {
        if (ws !== sock) return;
        if (waitingPong) return dead(sock);
        waitingPong = true;
        sock.send("ping");
      }, pingMs);
    });
    sock.addEventListener("message", (ev) => {
      if (ws === sock) onText(String(ev.data));
    });
    sock.addEventListener("close", (ev) => {
      if (ws === sock) closed(ev.code, ev.reason);
    });
    sock.addEventListener("error", () => {}); // следом всегда приходит close
  }

  // Нет pong: сокет считаем мёртвым сразу, не дожидаясь, пока закрытие дойдёт по сети.
  function dead(sock: WsLike) {
    ws = null;
    try {
      sock.close(4000, "no_pong");
    } catch {
      // сокет уже закрыт — ветка та же
    }
    closed(1006, "no_pong");
  }

  function closed(code: number, reason: string) {
    ws = null;
    stopTimers();
    failAll();
    if (state === "stopped") return;
    const fatal = (code === 1008 && reason !== "gate_unavailable") || (code === 1000 && reason === "replaced");
    if (fatal) return setState("stopped", reason);
    setState("closed", reason || String(code));
    pauseTimer = setTimeout(connect, pause);
    pause = Math.min(pause * 2, maxPause);
  }

  function onText(text: string) {
    if (text === "pong") {
      waitingPong = false;
      return;
    }
    const f = parseFrame(text);
    if (!f) return; // не кадр; relay шлёт только кадры
    if (f.type === "roster") {
      roster = f as unknown as Roster;
      if (state !== "open") {
        pause = firstPause;
        setState("open");
      }
      checkPending();
      o.onFrame?.(f);
      return;
    }
    if (isReply(f)) {
      const p = pending.get(f.id);
      if (p) {
        pending.delete(f.id);
        p.resolve(f);
        return;
      }
    }
    o.onFrame?.(f);
  }

  // Правило отправителя: ушёл адресат — ответа не будет, ждущий получает disconnected сразу.
  function checkPending() {
    for (const [id, p] of [...pending]) {
      const t = p.target;
      if (!t) continue;
      const gone = "machine" in t ? sinceOf(roster, t.machine) !== p.since : p.present && !hasName(roster, t.name);
      if (gone) {
        pending.delete(id);
        p.resolve(fail(id, "disconnected"));
      }
    }
  }

  connect();

  return {
    get state() {
      return state;
    },
    get roster() {
      return roster;
    },
    request(f: Frame): Promise<Reply> {
      const id = f.id ?? `${prefix}-${++seq}`;
      const sock = ws;
      if (state !== "open" || !sock) return Promise.resolve(fail(id, "disconnected"));
      const target = targetOf(f);
      const p: Omit<Pending, "resolve"> = {
        target,
        since: target && "machine" in target ? sinceOf(roster, target.machine) : undefined,
        present: !!target && "name" in target && hasName(roster, target.name),
      };
      const text = JSON.stringify({ ...f, id });
      const bytes = oversize(text);
      if (bytes !== null) return Promise.resolve(Object.assign(fail(id, TOO_LARGE), { bytes }));
      return new Promise<Reply>((resolve) => {
        pending.set(id, { ...p, resolve });
        sock.send(text);
      });
    },
    send(f: Frame) {
      if (state !== "open" || !ws) return { ok: false, error: "disconnected" } as const;
      let text = JSON.stringify(f);
      const bytes = oversize(text);
      if (bytes !== null) {
        if (!isReply(f)) return { ok: false, error: TOO_LARGE, bytes } as const;
        text = JSON.stringify({ ...fail(f.id, TOO_LARGE), bytes, ...(f.to !== undefined ? { to: f.to } : {}) });
      }
      ws.send(text);
      return { ok: true } as const;
    },
    close(code = 1000, reason = "closing") {
      const sock = ws;
      ws = null;
      stopTimers();
      setState("stopped", reason);
      failAll();
      sock?.close(code, reason);
    },
  };
}
