// Общий клиент флота: один типизированный вызов для страницы, Host, служб и скриптов; соединение с переподключением.
import type { InputOf, OutputOf, RequestDef } from "./define.ts";
import { CALL_MS, type Frame, isReply, newId, parseFrame, parsePass, PROTO, Refusal, type Reply, type Span, within } from "./frame.ts";

/** Провод: как кадр-запрос доходит до входа и как открыть соединение. Настоящий — httpTransport; у страницы в прототипе — мок. */
export interface Transport {
  /** запрос: кадр с id → ответ */
  call(f: Frame): Promise<Reply>;
  /** соединение: role page — картина флота; watch — лента сессий машины */
  open(role: "page" | "watch", opts: { machine?: string; onFrame: (f: Frame) => void; onState?: (s: LinkState) => void }): Link;
}

export type LinkState = "connecting" | "open" | "closed" | "stopped";
export interface Link {
  send(f: Frame): void;
  close(): void;
}

export class CallError extends Refusal {
  constructor(word: string, why: string | undefined, public trace?: string, public spans?: Span[]) {
    super(word, why);
  }
}

export interface Api {
  /** вызвать запрос договора; отказ — исключение CallError со словом */
  call<D extends RequestDef<any, any>>(def: D, input: InputOf<D>, opts?: { trace?: string }): Promise<OutputOf<D>>;
  transport: Transport;
}

export function createApi(transport: Transport): Api {
  return {
    transport,
    async call(def, input, opts) {
      const f: Frame = { ...(input as object), type: def.name, id: newId("r"), trace: opts?.trace ?? newId("t") };
      const r = await transport.call(f);
      if (!r.ok) throw new CallError(r.error ?? "module_failed", r.why, r.trace ?? f.trace, r.spans);
      return r.result as never;
    },
  };
}

export type SocketLike = { send(data: string): void; close(code?: number, reason?: string): void; addEventListener(type: string, fn: (e: any) => void): void; readyState: number };

/** Соединение с переподключением: пауза растёт и разбросана, чтобы после обновления платформы все не пришли разом. */
export function socketLink(o: {
  url: string;
  hello: Frame;
  onFrame: (f: Frame) => void;
  onState?: (s: LinkState) => void;
  WebSocket?: new (url: string) => SocketLike;
  /** слова закрытия, после которых не переподключаемся: пропуск отозван или не принят, конверт не тот */
  stopOn?: string[];
}): Link {
  const WS = o.WebSocket ?? ((globalThis as any).WebSocket as new (url: string) => SocketLike);
  const stopOn = o.stopOn ?? ["bad_key", "revoked", "forbidden", "proto", "replaced"];
  let ws: SocketLike | null = null, closed = false, tries = 0, timer: ReturnType<typeof setTimeout> | null = null;
  const queue: string[] = [];
  const connect = () => {
    if (closed) return;
    o.onState?.("connecting");
    const s = (ws = new WS(o.url));
    s.addEventListener("open", () => {
      tries = 0;
      s.send(JSON.stringify(o.hello));
      for (const q of queue.splice(0)) s.send(q);
      o.onState?.("open");
    });
    s.addEventListener("message", (e: { data: unknown }) => {
      const f = typeof e.data === "string" ? parseFrame(e.data) : null;
      if (f) o.onFrame(f);
    });
    s.addEventListener("close", (e: { reason?: string }) => {
      if (ws !== s) return;
      ws = null;
      if (closed) return;
      if (e.reason && stopOn.includes(e.reason)) {
        closed = true;
        o.onState?.("stopped");
        return;
      }
      o.onState?.("closed");
      const pause = Math.min(30_000, 500 * 2 ** tries++) * (0.5 + Math.random());
      timer = setTimeout(connect, pause);
    });
    s.addEventListener("error", () => {});
  };
  connect();
  return {
    send(f) {
      const text = JSON.stringify(f);
      if (ws && ws.readyState === 1) ws.send(text);
      else queue.push(text);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close(1000, "bye");
    },
  };
}

/** Настоящий провод: POST /call и WebSocket на /f и /m/<машина> одного адреса флота. */
export function httpTransport(o: { base: string; key: string; fetch?: typeof fetch; WebSocket?: new (url: string) => SocketLike }): Transport {
  const f = o.fetch ?? fetch;
  const wsBase = o.base.replace(/^http/, "ws");
  return {
    async call(frame) {
      let res: Response;
      try {
        res = await within(f(o.base + "/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + o.key }, body: JSON.stringify(frame) }), CALL_MS);
      } catch (e) {
        return { type: "reply", id: frame.id!, ok: false, error: e instanceof Refusal ? e.word : "offline", why: e instanceof Error ? e.message : String(e), trace: frame.trace };
      }
      const r = parseFrame(await res.text());
      if (!r || !isReply(r)) return { type: "reply", id: frame.id!, ok: false, error: "bad_frame", why: "вход ответил не кадром, HTTP " + res.status, trace: frame.trace };
      return r;
    },
    open(role, opts) {
      const fleet = parsePass(o.key)?.fleet ?? "";
      const url = role === "page" ? wsBase + "/f/" + fleet : wsBase + "/m/" + fleet + "/" + opts.machine;
      return socketLink({ url, hello: { type: "hello", proto: PROTO, key: o.key, role }, onFrame: opts.onFrame, onState: opts.onState, WebSocket: o.WebSocket });
    },
  };
}
