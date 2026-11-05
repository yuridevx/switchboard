// Клиент link: соединение с объектом relay по wss. Им пользуются ядро Host, веб-приложения и скрипты.
// Работает в Node 24 (глобальный WebSocket) и в браузере; в тестах WebSocket подставляется.
import { CALL_MS, READ_MS, fail, isReply, oversize, parseFrame, TOO_LARGE } from "@switchboard/protocol";
import type { Frame, Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";
import { backoff } from "./backoff.ts";
import { Waiting } from "./waiting.ts";

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

type LinkOptions = {
  /** wss://switchboard.<subdomain>.workers.dev/m/<машина> */
  url: string;
  /** ключ флота role.name.kid.sig — из stdin, переменной окружения или хранилища; не из argv */
  key: string;
  /**
   * Поля hello сверх type, key, proto — зовётся на каждом подключении, чтобы hello нёс свежее:
   * Host — { sdk, contract, sessions }, клиент — обычно ничего.
   */
  hello?: () => Record<string, unknown>;
  /** Каждый входящий кадр, кроме ответов на свои запросы: roster (после того, как link его учёл), запросы, кадры с to. */
  onFrame?: (f: Frame) => void;
  /** Смена состояния; why — слово или причина закрытия; retryAt — у closed: когда следующая попытка (мс). */
  onState?: (state: LinkState, why?: string, retryAt?: number) => void;
  /** Период ping, мс. Нет pong к следующему ping — соединение мёртвое: закрыть и переподключиться. По умолчанию 30 000. */
  pingMs?: number;
  /** Первая пауза переподключения, мс; растёт вдвое, сбрасывается после принятого hello. По умолчанию 1 000. */
  pauseMs?: number;
  /** Потолок паузы, мс. По умолчанию 60 000. */
  maxPauseMs?: number;
  /** Предел запроса, мс: нет ответа — timeout. По умолчанию CALL_MS — вдвое выше самого долгого законного запроса (session.open до 62 с). */
  requestMs?: number;
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
   * или его машина сменила since — disconnected. Нет ответа за предел requestMs — timeout; поздний ответ — в onFrame как ответ без ждущего.
   * Кадр больше MAX_FRAME не уходит: сразу too_large { bytes } — relay порвал бы соединение всей машины.
   * read — запрос только читает: предел READ_MS, но не дольше requestMs.
   */
  request(f: Frame, read?: boolean): Promise<Reply>;
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

/** Закрытие relay, после которого переподключаться незачем: gate_unavailable — обычный обрыв. */
const isFinal = (code: number, reason: string) => (code === 1008 && reason !== "gate_unavailable") || (code === 1000 && reason === "replaced");

/** Открыть связь с relay. Подключается сразу; дальше живёт сама до close() или отказа relay. */
export function link(o: LinkOptions): Link {
  const Ws = o.WebSocket ?? (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket;
  if (!Ws) throw new Error("link: нет WebSocket — передайте options.WebSocket");
  const requestMs = o.requestMs ?? CALL_MS;
  const pause = backoff(o.pauseMs, o.maxPauseMs);
  const waiting = new Waiting();
  // свой префикс id: два соединения с одним именем клиента получают ответы друг друга по to
  const prefix = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  let state: LinkState = "connecting";
  let roster: Roster | null = null;
  let sock: WsLike | null = null;
  /** таймеры и pong нынешнего сокета */
  let stopWatching = () => {};
  let retry: ReturnType<typeof setTimeout> | undefined;

  function setState(next: LinkState, why?: string, retryAt?: number): void {
    if (state === next && why === undefined) return;
    state = next;
    o.onState?.(next, why, retryAt);
  }

  function connect(): void {
    setState("connecting");
    const ws = new Ws!(o.url);
    sock = ws;
    let awaitingPong = false;
    ws.addEventListener("open", () => {
      if (sock !== ws) return;
      ws.send(JSON.stringify({ ...o.hello?.(), type: "hello", key: o.key, proto: PROTO }));
      // ответ на hello — первый roster; не пришёл за предел запроса — hello потерян, соединение мёртвое
      const helloTimer = setTimeout(() => {
        if (sock === ws && state !== "open") dead(ws, "no_roster");
      }, requestMs);
      const pingTimer = setInterval(() => {
        if (sock !== ws) return;
        if (awaitingPong) return dead(ws, "no_pong");
        awaitingPong = true;
        ws.send("ping");
      }, o.pingMs ?? 30_000);
      stopWatching = () => {
        clearTimeout(helloTimer);
        clearInterval(pingTimer);
      };
    });
    ws.addEventListener("message", ({ data }) => {
      if (sock !== ws) return;
      if (data === "pong") awaitingPong = false;
      else onText(String(data));
    });
    ws.addEventListener("close", ({ code, reason }) => {
      if (sock === ws) closed(code, reason);
    });
    ws.addEventListener("error", () => {}); // следом всегда приходит close
  }

  /** Нет pong или roster на hello: сокет считаем мёртвым сразу, не дожидаясь, пока закрытие дойдёт по сети. */
  function dead(ws: WsLike, why: string): void {
    sock = null;
    try {
      ws.close(4000, why);
    } catch {
      // сокет уже закрыт — ветка та же
    }
    closed(1006, why);
  }

  function closed(code: number, reason: string): void {
    sock = null;
    stopWatching();
    waiting.dropAll();
    if (state === "stopped") return;
    if (isFinal(code, reason)) return setState("stopped", reason);
    const wait = pause.next();
    setState("closed", reason || String(code), Date.now() + wait);
    retry = setTimeout(connect, wait);
  }

  function onText(text: string): void {
    const f = parseFrame(text);
    if (!f) return; // не кадр; relay шлёт только кадры
    if (isReply(f) && waiting.answer(f)) return;
    if (f.type === "roster") {
      roster = f as unknown as Roster;
      if (state !== "open") {
        pause.reset();
        setState("open");
      }
      waiting.rosterChanged(roster);
    }
    o.onFrame?.(f);
  }

  connect();

  return {
    get state() {
      return state;
    },
    get roster() {
      return roster;
    },
    request(f, read = false) {
      const framed = { ...f, id: f.id ?? `${prefix}-${++seq}` };
      if (state !== "open" || !sock) return Promise.resolve(fail(framed.id, "disconnected"));
      const text = JSON.stringify(framed);
      const bytes = oversize(text);
      if (bytes !== null) return Promise.resolve(Object.assign(fail(framed.id, TOO_LARGE), { bytes }));
      const answer = waiting.add(framed, roster, read ? Math.min(READ_MS, requestMs) : requestMs);
      sock.send(text);
      return answer;
    },
    send(f) {
      if (state !== "open" || !sock) return { ok: false, error: "disconnected" };
      let text = JSON.stringify(f);
      const bytes = oversize(text);
      if (bytes !== null) {
        if (!isReply(f)) return { ok: false, error: TOO_LARGE, bytes };
        text = JSON.stringify({ ...fail(f.id, TOO_LARGE), bytes, to: f.to });
      }
      sock.send(text);
      return { ok: true };
    },
    close(code = 1000, reason = "closing") {
      const ws = sock;
      sock = null;
      stopWatching();
      if (retry !== undefined) clearTimeout(retry);
      setState("stopped", reason);
      waiting.dropAll();
      ws?.close(code, reason);
    },
  };
}
