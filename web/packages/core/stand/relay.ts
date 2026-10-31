// Стенд веб-приложений: поддельный relay за подставным WebSocket. Код приложения и link — настоящие.
// relay.WebSocket отдаётся в startApp({ WebSocket }); кадры приложения — в relay.got, ответы — по обработчикам.
import type { Frame, Roster } from "@switchboard/relay";

type Answer = { ok: true; result?: unknown } | { ok: false; error: string };
/** Обработчик запроса по type: ответ, или undefined — ответа пока нет (тест ответит сам через relay.reply). */
export type Handler = (f: Frame) => Answer | undefined;

export class FakeRelay {
  socks: FakeSock[] = [];
  /** кадры приложения (кроме hello и ping) */
  got: Frame[] = [];
  hellos: Frame[] = [];
  handlers: Record<string, Handler> = {};
  /** отказ следующим hello: слово закрытия 1008 (revoked, contract_mismatch, gate_unavailable…) */
  refuse: string[] = [];
  roster: Roster;
  readonly WebSocket: new (url: string) => FakeSock;

  constructor(roster: Roster) {
    this.roster = roster;
    const relay = this;
    this.WebSocket = class extends FakeSock {
      constructor(url: string) {
        super(url, relay);
      }
    };
  }

  /** открытые соединения */
  get open(): FakeSock[] {
    return this.socks.filter((s) => s.readyState === 1 && s.helloed);
  }

  /** кадр всем открытым соединениям (как relay по to) */
  push(f: Frame | Record<string, unknown>) {
    for (const s of this.open) s.recv(f);
  }

  /** новый roster всем */
  setRoster(r: Roster) {
    this.roster = r;
    this.push(r);
  }

  /** ответить на запрос с id */
  reply(id: string, a: Answer) {
    this.push({ type: "reply", id, ...a });
  }

  /** оборвать все соединения */
  drop(code = 1006, reason = "") {
    for (const s of this.socks) if (s.readyState === 1) s.serverClose(code, reason);
  }

  /** запросы приложения данного type */
  sent(type: string): Frame[] {
    return this.got.filter((f) => f.type === type);
  }
}

type L = Record<string, Array<(ev: any) => void>>;

export class FakeSock {
  readyState = 0;
  helloed = false;
  closedWith: { code?: number; reason?: string } | null = null;
  private ls: L = { open: [], message: [], close: [], error: [] };
  readonly url: string;
  private relay: FakeRelay;
  constructor(url: string, relay: FakeRelay) {
    this.url = url;
    this.relay = relay;
    relay.socks.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.ls.open.forEach((f) => f({}));
    }, 0);
  }
  addEventListener(t: string, fn: (ev: any) => void) {
    this.ls[t].push(fn);
  }
  send(data: string) {
    if (this.readyState !== 1) return;
    if (data === "ping") return void setTimeout(() => this.recv("pong"), 0);
    const f = JSON.parse(data) as Frame;
    if (f.type === "hello") {
      this.relay.hellos.push(f);
      const no = this.relay.refuse.shift();
      if (no) return void setTimeout(() => this.serverClose(1008, no), 0);
      this.helloed = true;
      return void setTimeout(() => this.recv(this.relay.roster), 0);
    }
    this.relay.got.push(f);
    const hd = this.relay.handlers[f.type];
    if (typeof f.id === "string" && hd) {
      const a = hd(f);
      if (a) setTimeout(() => this.recv({ type: "reply", id: f.id, ...a }), 0);
    }
  }
  close(code?: number, reason?: string) {
    if (this.readyState >= 2) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    setTimeout(() => this.ls.close.forEach((fn) => fn({ code: code ?? 1005, reason: reason ?? "" })), 0);
  }
  recv(f: unknown) {
    if (this.readyState !== 1) return;
    this.ls.message.forEach((fn) => fn({ data: typeof f === "string" ? f : JSON.stringify(f) }));
  }
  serverClose(code: number, reason: string) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.ls.close.forEach((fn) => fn({ code, reason }));
  }
}

/** Дать отработать таймерам и обещаниям стенда. */
export async function flush(n = 6) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Флот home из дизайна: laptop и pc, четыре сессии, Worker push. */
export function homeRoster(over: Partial<Roster> = {}): Roster {
  const contract = {
    message: 1,
    answer: 1,
    answered: 1,
    question: 1,
    "question.list": 1,
    "session.watch": 1,
    "session.unwatch": 1,
    "session.events": 1,
    "session.history": 1,
    "session.prompt": 1,
    "session.stop": 1,
    "session.start": 1,
    notify: 1,
  };
  return {
    type: "roster",
    machines: [
      { machine: "laptop", since: 1, proto: 1, contract },
      { machine: "pc", since: 1, proto: 1, contract },
    ],
    sessions: [
      { callsign: "site@laptop", state: "busy", model: "opus", effort: "high", slot: { name: "main", wait: null }, account: "y0902" },
      { callsign: "profiles@laptop", state: "waiting", model: "opus", slot: { name: "main", wait: null } },
      { callsign: "poe-bot@pc", state: "idle", model: "sonnet", slot: { name: "main", wait: null } },
      { callsign: "wiki@pc", state: "stopped", model: "sonnet", slot: { name: "main", wait: null } },
    ],
    clients: ["phone", "panel-desk"],
    workers: [{ name: "push", contract: { "push.key": 1, "push.send": 1, "push.subscribe": 1 } }],
    ...over,
  };
}

export const KEY = "client.phone.k2a9.Vt5sig";
