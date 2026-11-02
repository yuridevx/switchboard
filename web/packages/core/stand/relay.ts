// Стенд веб-приложений: поддельный relay за подставным WebSocket и Worker'ы флота за подставным fetch.
// Код приложения и клиент флота — настоящие. relay.WebSocket и relay.fetch отдаются в startApp; соединение /m/<машина> —
// объект этой машины: его roster — своя машина, её сессии, гости и Worker'ы. Кадры приложения — в relay.got,
// ответы — по обработчикам; POST к Worker'у — тот же обработчик, ответ — телом.
import { machineOf } from "@switchboard/protocol";
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
  /** POST к Worker'ам, ждущие ответа теста relay.reply */
  private posts = new Map<string, (r: Response) => void>();
  /** чьё соединение спросило запрос с этим id */
  asked = new Map<string, FakeSock>();
  /** Worker'ы стенда для startApp({ workers }) */
  static readonly WORKERS = Object.fromEntries(["gate", "relay", "push", "points", "ledger", "github", "releases"].map((n) => [n, `https://${n}.test/`]));

  /** fetch приложения: keys.list у gate — машины roster; прочее — обработчик по type, как у кадра через relay. */
  readonly fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const { key: _k, ...f } = JSON.parse(String(init?.body)) as Frame;
    if (String(url) === FakeRelay.WORKERS.gate && f.type === "keys.list") {
      return Response.json({ type: "reply", id: f.id, ok: true, result: { passes: this.roster.machines.map((m) => ({ name: m.machine, role: "host", state: "ok" })) } });
    }
    this.got.push(f as Frame);
    if (typeof f.id !== "string") return new Response(null, { status: 204 });
    const hd = this.handlers[f.type];
    const a = hd?.(f as Frame);
    if (a) return Response.json({ type: "reply", id: f.id, ...a });
    return new Promise<Response>((res) => this.posts.set(f.id as string, res));
  }) as typeof fetch;

  /** roster объекта машины: своя машина и её сессии; гости и Worker'ы — общие стенда. */
  rosterOf(sock: FakeSock): Roster {
    const m = /\/m\/([^/?#]+)/.exec(sock.url)?.[1];
    if (!m) return this.roster;
    return { ...this.roster, machines: this.roster.machines.filter((x) => x.machine === m), sessions: this.roster.sessions.filter((s) => machineOf(s.callsign) === m) };
  }

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

  /** кадр приложению — с объекта машины отправителя, иначе с первого открытого */
  push(f: Frame | Record<string, unknown>) {
    const m = typeof f.from === "string" ? machineOf(f.from) : null;
    const s = this.open.find((x) => m && x.url.endsWith(`/m/${m}`)) ?? this.open[0];
    s?.recv(f);
  }

  /** новый roster всем: каждому объекту — свой */
  setRoster(r: Roster) {
    this.roster = r;
    for (const s of this.open) s.recv(this.rosterOf(s));
  }

  /** ответить на запрос с id: POST — телом, кадр — тому соединению, что спросило */
  reply(id: string, a: Answer) {
    const post = this.posts.get(id);
    if (post) {
      this.posts.delete(id);
      return post(Response.json({ type: "reply", id, ...a }));
    }
    const s = this.asked.get(id);
    if (s && s.readyState === 1) return s.recv({ type: "reply", id, ...a });
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
      return void setTimeout(() => this.recv(this.relay.rosterOf(this)), 0);
    }
    this.relay.got.push(f);
    if (typeof f.id === "string") this.relay.asked.set(f.id, this);
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
/** Приглашение стенда: номер и 43 знака секрета. */
export const INVITE = "p3a1." + "A".repeat(43);

/** Флот из одной машины laptop: одно соединение — один hello. */
export function oneMachine(over: Partial<Roster> = {}): Roster {
  const r = homeRoster();
  return homeRoster({ machines: [r.machines[0]], sessions: r.sessions.filter((s) => s.callsign.endsWith("@laptop")), ...over });
}
