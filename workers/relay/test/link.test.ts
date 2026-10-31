// Клиент link на поддельном WebSocket: hello, запросы, правило отправителя по roster, ping, переподключение.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { link, PROTO, type LinkState, type WsLike } from "../contract.ts";

type L = Record<string, Array<(ev: any) => void>>;

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private ls: L = { open: [], message: [], close: [], error: [] };
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.all.push(this);
  }
  addEventListener(t: string, fn: (ev: any) => void) {
    this.ls[t].push(fn);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
  }
  // управление из теста
  open() {
    this.readyState = 1;
    this.ls.open.forEach((f) => f({}));
  }
  recv(f: unknown) {
    this.ls.message.forEach((fn) => fn({ data: typeof f === "string" ? f : JSON.stringify(f) }));
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.ls.close.forEach((fn) => fn({ code, reason }));
  }
  json(i = -1) {
    return JSON.parse(this.sent.at(i)!);
  }
  static last() {
    return FakeWs.all.at(-1)!;
  }
}

const roster = (machines: Array<[string, number]> = [["laptop", 1], ["pc", 1]], clients = ["phone"], workers = ["push"]) => ({
  type: "roster",
  machines: machines.map(([machine, since]) => ({ machine, since, proto: 1 })),
  sessions: [],
  clients,
  workers: workers.map((name) => ({ name, contract: {} })),
});

function start(extra: Record<string, unknown> = {}) {
  const states: Array<[LinkState, string | undefined]> = [];
  const frames: any[] = [];
  const l = link({
    url: "wss://relay.test",
    key: "client.panel-desk.k3f1.sig",
    WebSocket: FakeWs,
    onState: (s, why) => states.push([s, why]),
    onFrame: (f) => frames.push(f),
    ...extra,
  });
  return { l, states, frames, ws: FakeWs.last() };
}

/** Связь открыта: сокет открыт, hello ушёл, пришёл roster. */
function opened(extra: Record<string, unknown> = {}) {
  const t = start(extra);
  t.ws.open();
  t.ws.recv(roster());
  return t;
}

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("link · hello", () => {
  it("первым кадром — hello с ключом, proto и полями hello(); open — после первого roster", () => {
    const { l, ws, states } = start({ hello: () => ({ sdk: "0.3.311", contract: { message: 1 }, sessions: [{ callsign: "site@laptop" }] }) });
    expect(l.state).toBe("connecting");
    ws.open();
    expect(ws.json(0)).toEqual({ type: "hello", key: "client.panel-desk.k3f1.sig", proto: PROTO, sdk: "0.3.311", contract: { message: 1 }, sessions: [{ callsign: "site@laptop" }] });
    expect(l.state).toBe("connecting");
    ws.recv(roster());
    expect(l.state).toBe("open");
    expect(l.roster?.machines.map((m) => m.machine)).toEqual(["laptop", "pc"]);
    expect(states).toEqual([["open", undefined]]);
  });

  it("roster уходит и в onFrame — модулям, у кого он в uses", () => {
    const { frames } = opened();
    expect(frames.map((f) => f.type)).toEqual(["roster"]);
  });
});

describe("link · запросы", () => {
  it("запрос получает свой id и ответ с тем же id; чужой reply — в onFrame", async () => {
    const { l, ws, frames } = opened();
    const p = l.request({ type: "message", to: "poe-bot@pc", text: "hi" });
    const sent = ws.json();
    expect(sent).toMatchObject({ type: "message", to: "poe-bot@pc", text: "hi" });
    expect(typeof sent.id).toBe("string");
    ws.recv({ type: "reply", id: "чужой", ok: true });
    ws.recv({ type: "reply", id: sent.id, ok: true, result: { done: 1 }, from: "@pc" });
    expect(await p).toMatchObject({ id: sent.id, ok: true, result: { done: 1 } });
    expect(frames.filter((f) => f.type === "reply").map((f) => f.id)).toEqual(["чужой"]);
  });

  it("свой id запроса сохраняется; отказ relay приходит ответом, не исключением", async () => {
    const { l, ws } = opened();
    const p = l.request({ type: "session.open", id: "c-7", machine: "pc" });
    expect(ws.json().id).toBe("c-7");
    ws.recv({ type: "reply", id: "c-7", ok: false, error: "offline" });
    expect(await p).toEqual({ type: "reply", id: "c-7", ok: false, error: "offline" });
  });

  it("связи нет — запрос сразу disconnected, send — false; очереди нет", async () => {
    const { l, ws } = start();
    ws.open();
    expect(await l.request({ type: "message", to: "site@laptop" })).toMatchObject({ ok: false, error: "disconnected" });
    expect(l.send({ type: "question", to: "phone" })).toBe(false);
    expect(ws.sent.length).toBe(1); // только hello
  });

  it("обрыв — ждущие запросы сразу disconnected, без таймера", async () => {
    const { l, ws } = opened();
    const a = l.request({ type: "message", to: "site@laptop" });
    const b = l.request({ type: "session.history", callsign: "wiki@pc" });
    ws.drop(1006);
    expect(await a).toMatchObject({ ok: false, error: "disconnected" });
    expect(await b).toMatchObject({ ok: false, error: "disconnected" });
    expect(l.state).toBe("closed");
  });
});

describe("link · правило отправителя по roster", () => {
  it("машина адресата ушла из roster — ждущий её ответа запрос disconnected; запрос к другой машине ждёт", async () => {
    const { l, ws } = opened();
    let pcDone = false;
    const toPc = l.request({ type: "message", to: "poe-bot@pc" });
    const toLaptop = l.request({ type: "session.history", callsign: "site@laptop" });
    void toLaptop.then(() => (pcDone = true));
    ws.recv(roster([["laptop", 1]]));
    expect(await toPc).toMatchObject({ ok: false, error: "disconnected" });
    await Promise.resolve();
    expect(pcDone).toBe(false);
    const id = JSON.parse(ws.sent[2]).id;
    ws.recv({ type: "reply", id, ok: true });
    expect(await toLaptop).toMatchObject({ ok: true });
  });

  it("машина адресата сменила since — disconnected (Host переподключился, старого запроса не помнит)", async () => {
    const { l, ws } = opened();
    const p = l.request({ type: "session.open", machine: "pc" });
    ws.recv(roster([["laptop", 1], ["pc", 1]]));
    ws.recv(roster([["laptop", 1], ["pc", 2]]));
    expect(await p).toMatchObject({ ok: false, error: "disconnected" });
  });

  it("клиент или участник ушёл из roster — disconnected; @машина — по машине", async () => {
    const { l, ws } = opened();
    const toPhone = l.request({ type: "message", to: "phone" });
    const toPush = l.request({ type: "push.send", to: "push" });
    const toMachine = l.request({ type: "machine.dirs", to: "@laptop" });
    ws.recv(roster([["pc", 1]], [], []));
    expect(await toPhone).toMatchObject({ error: "disconnected" });
    expect(await toPush).toMatchObject({ error: "disconnected" });
    expect(await toMachine).toMatchObject({ error: "disconnected" });
  });
});

describe("link · переподключение", () => {
  it("пауза 1, 2, 4 с; после принятого hello — снова 1 с; hello на каждом подключении", () => {
    let n = 0;
    const { ws } = start({ hello: () => ({ n: ++n }) });
    ws.drop(1006);
    expect(FakeWs.all.length).toBe(1);
    vi.advanceTimersByTime(999);
    expect(FakeWs.all.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all.length).toBe(2);
    FakeWs.last().drop(1006);
    vi.advanceTimersByTime(1999);
    expect(FakeWs.all.length).toBe(2);
    vi.advanceTimersByTime(1);
    FakeWs.last().drop(1008, "gate_unavailable"); // та же ветка, что обрыв
    vi.advanceTimersByTime(4000);
    expect(FakeWs.all.length).toBe(4);
    const w = FakeWs.last();
    w.open();
    expect(w.json(0).n).toBe(1);
    w.recv(roster());
    w.drop(1001);
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all.length).toBe(5);
  });

  it.each([
    [1008, "bad_key"],
    [1008, "revoked"],
    [1008, "contract_mismatch"],
    [1008, "bad_from"],
    [1000, "replaced"],
  ])("закрытие %i %s — stopped с причиной, без переподключения", (code, reason) => {
    const { l, ws, states } = opened();
    ws.drop(code, reason);
    vi.advanceTimersByTime(120_000);
    expect(FakeWs.all.length).toBe(1);
    expect(l.state).toBe("stopped");
    expect(states.at(-1)).toEqual(["stopped", reason]);
  });

  it("пауза не больше maxPauseMs", () => {
    start({ maxPauseMs: 3000 });
    for (let i = 0; i < 5; i++) {
      FakeWs.last().drop(1006);
      vi.advanceTimersByTime(3000);
    }
    expect(FakeWs.all.length).toBe(6);
  });
});

describe("link · ping", () => {
  it("ping с периодом; pong — живо; нет pong к следующему ping — закрыть и переподключиться", async () => {
    const { l, ws } = opened({ pingMs: 1000 });
    const p = l.request({ type: "message", to: "site@laptop" });
    vi.advanceTimersByTime(1000);
    expect(ws.sent.at(-1)).toBe("ping");
    ws.recv("pong");
    vi.advanceTimersByTime(1000);
    expect(ws.sent.at(-1)).toBe("ping");
    expect(ws.closedWith).toBeNull();
    vi.advanceTimersByTime(1000); // pong не пришёл
    expect(ws.closedWith).toEqual({ code: 4000, reason: "no_pong" });
    expect(l.state).toBe("closed");
    expect(await p).toMatchObject({ error: "disconnected" });
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all.length).toBe(2);
  });
});

describe("link · штатная остановка", () => {
  it("close(): ждущие disconnected, сокет закрыт с кодом и причиной, переподключений нет", async () => {
    const { l, ws, states } = opened();
    const p = l.request({ type: "message", to: "site@laptop" });
    l.close(1000, "shutting_down");
    expect(await p).toMatchObject({ error: "disconnected" });
    expect(ws.closedWith).toEqual({ code: 1000, reason: "shutting_down" });
    ws.drop(1000, "shutting_down");
    vi.advanceTimersByTime(120_000);
    expect(FakeWs.all.length).toBe(1);
    expect(states.at(-1)).toEqual(["stopped", "shutting_down"]);
  });
});
