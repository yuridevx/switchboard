// Клиент link на поддельном WebSocket: hello, запросы, правило отправителя по roster, ping, переподключение.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAME } from "@switchboard/protocol";
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

const roster = (machines: Array<[string, number]> = [["laptop", 1], ["pc", 1]], clients = ["phone~owner@example.com"], workers = ["push"]) => ({
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
    const { l, ws, states, frames } = start({ hello: () => ({ sdk: "0.3.311", contract: { message: 1 }, sessions: [{ callsign: "site@laptop" }] }) });
    expect(l.state).toBe("connecting");
    ws.open();
    expect(ws.json(0)).toEqual({ type: "hello", key: "client.panel-desk.k3f1.sig", proto: PROTO, sdk: "0.3.311", contract: { message: 1 }, sessions: [{ callsign: "site@laptop" }] });
    expect(l.state).toBe("connecting");
    ws.recv(roster());
    expect(l.state).toBe("open");
    expect(l.roster?.machines.map((m) => m.machine)).toEqual(["laptop", "pc"]);
    expect(states).toEqual([["open", undefined]]);
    // roster уходит и в onFrame — модулям, у кого он в uses
    expect(frames.map((f) => f.type)).toEqual(["roster"]);
  });

  it("2053 · нет WebSocket — исключение при вызове", () => {
    const g = globalThis as unknown as { WebSocket?: unknown };
    const saved = g.WebSocket;
    delete g.WebSocket;
    try {
      expect(() => link({ url: "wss://relay.test", key: "k" })).toThrow("link: нет WebSocket — передайте options.WebSocket");
    } finally {
      g.WebSocket = saved;
    }
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

  it("связи нет — запрос и send сразу disconnected; очереди нет", async () => {
    const { l, ws } = start();
    ws.open();
    expect(await l.request({ type: "message", to: "site@laptop" })).toMatchObject({ ok: false, error: "disconnected" });
    expect(l.send({ type: "question", to: "phone" })).toEqual({ ok: false, error: "disconnected" });
    expect(ws.sent.length).toBe(1); // только hello
  });

  it("279 · кадр больше 32 МиБ: запрос не ушёл — ждущему too_large с байтами; ответ заменён отказом too_large тому же адресату; прочий кадр не ушёл — отправителю too_large с байтами; соединение живо", async () => {
    const { l, ws, states } = opened();
    const big = "я".repeat(17 * 1024 * 1024); // 34 МиБ в UTF-8
    const r = await l.request({ type: "shell.run", machine: "pc", script: big });
    expect(r).toMatchObject({ type: "reply", ok: false, error: "too_large" });
    expect((r as unknown as { bytes: number }).bytes).toBeGreaterThan(MAX_FRAME);
    expect(ws.sent.length).toBe(1); // только hello
    expect(l.send({ type: "reply", id: "q1", ok: true, result: { stdout: big }, to: "site@pc" })).toEqual({ ok: true });
    const sent = ws.json();
    expect(sent).toMatchObject({ type: "reply", id: "q1", ok: false, error: "too_large", to: "site@pc" });
    expect(sent.bytes).toBeGreaterThan(MAX_FRAME);
    expect(sent).not.toHaveProperty("result");
    expect(l.send({ type: "note", to: "site@pc", text: big })).toMatchObject({ ok: false, error: "too_large", bytes: expect.any(Number) });
    expect(ws.sent.length).toBe(2);
    expect(l.state).toBe("open");
    expect(states).toEqual([["open", undefined]]);
    // в пределе — как прежде
    const small = l.request({ type: "message", to: "poe-bot@pc", text: "hi" });
    ws.recv({ type: "reply", id: ws.json().id, ok: true });
    expect(await small).toMatchObject({ ok: true });
  });

  it("3119 · ответ потерян в пути, связь жива — ждущий получает timeout за предел запроса; поздний ответ — в onFrame; другие запросы не задеты", async () => {
    // источник: слово пользователя «у всех операций должен быть лимит» (2 нояб.); факт — Host 1.1.56 висел в stopping на github.token без ответа
    const { l, ws, frames } = opened({ requestMs: 5_000 });
    const lost = l.request({ type: "github.token", to: ".github", repo: "o/r" });
    const lostId = ws.json().id;
    let done = false;
    void lost.then(() => (done = true));
    vi.advanceTimersByTime(4_999);
    await Promise.resolve();
    expect(done).toBe(false);
    const ok = l.request({ type: "message", to: "site@laptop" });
    vi.advanceTimersByTime(1);
    expect(await lost).toEqual({ type: "reply", id: lostId, ok: false, error: "timeout" });
    ws.recv({ type: "reply", id: lostId, ok: true });
    expect(frames.filter((f) => f.type === "reply").map((f) => f.id)).toEqual([lostId]);
    ws.recv({ type: "reply", id: ws.json().id, ok: true });
    expect(await ok).toMatchObject({ ok: true });
    expect(l.state).toBe("open");
  });

  it("3143 · hello без ответа — связь не висит в connecting: за предел запроса сокет закрыт 4000 no_roster, переподключение по паузе", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; факт — hello теряется при смене кода relay
    const { l, ws, states } = start({ requestMs: 5_000, pingMs: 1_000_000 });
    ws.open();
    vi.advanceTimersByTime(4_999);
    expect(l.state).toBe("connecting");
    vi.advanceTimersByTime(1);
    expect(ws.closedWith).toEqual({ code: 4000, reason: "no_roster" });
    expect(l.state).toBe("closed");
    expect(states.at(-1)).toEqual(["closed", "no_roster"]);
    vi.advanceTimersByTime(1_000);
    const next = FakeWs.last();
    expect(next).not.toBe(ws);
    next.open();
    next.recv(roster());
    vi.advanceTimersByTime(10_000);
    expect(l.state).toBe("open");
    expect(next.closedWith).toBeNull();
  });

  it("3120 · предел запроса по умолчанию — 120 с", async () => {
    // источник: чьё: код (вдвое выше самого долгого законного запроса — session.open на wsl до 62 с, 1 нояб.)
    const { l } = opened({ pingMs: 1_000_000 });
    const p = l.request({ type: "session.open", machine: "pc" });
    let r: unknown;
    void p.then((x) => (r = x));
    vi.advanceTimersByTime(119_999);
    await Promise.resolve();
    expect(r).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(await p).toMatchObject({ ok: false, error: "timeout" });
  });

  it("3144 · relay закрыл 1012 relay_updated (выпуск relay) — ждущие сразу disconnected, link переподключается и входит заново", async () => {
    // источник: устав «соединение с Worker-модулем оборвалось — клиенты переподключаются»; чьё: код (1012 не фатален)
    const { l, ws } = opened();
    const p = l.request({ type: "keeper.state", to: ".keeper@laptop" });
    ws.drop(1012, "relay_updated");
    expect(await p).toMatchObject({ ok: false, error: "disconnected" });
    expect(l.state).toBe("closed");
    vi.advanceTimersByTime(1_000);
    const next = FakeWs.last();
    expect(next).not.toBe(ws);
    next.open();
    expect(next.json(0).type).toBe("hello");
  });

  it("обрыв — ждущие запросы сразу disconnected, не дожидаясь предела", async () => {
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

  it("2054 · клиент ушёл из roster — disconnected; @машина — по машине; часть машины и пользователь по roster не снимаются", async () => {
    const { l, ws } = opened();
    const toPhone = l.request({ type: "message", to: "phone~owner@example.com" });
    const toMachine = l.request({ type: "machine.dirs", to: "@laptop" });
    const toKeeper = l.request({ type: "keeper.state", to: ".keeper@laptop" });
    const toUser = l.request({ type: "message", to: "~owner@example.com" });
    let settled = 0;
    void toKeeper.then(() => settled++);
    void toUser.then(() => settled++);
    ws.recv(roster([["pc", 1]], [], []));
    expect(await toPhone).toMatchObject({ error: "disconnected" });
    expect(await toMachine).toMatchObject({ error: "disconnected" });
    await Promise.resolve();
    expect(settled).toBe(0);
    ws.recv({ type: "reply", id: JSON.parse(ws.sent[3]).id, ok: true });
    expect(await toKeeper).toMatchObject({ ok: true });
  });

  it("2055 · входящий запрос и кадр с to — в onFrame; отвечает send с to = from", () => {
    const { l, ws, frames } = opened();
    const req = { type: "session.history", id: "h-3", callsign: "site@laptop", from: "panel~o" };
    ws.recv(req);
    ws.recv({ type: "question", to: "panel~o", question: "q" });
    expect(frames.filter((f) => f.type !== "roster")).toEqual([req, { type: "question", to: "panel~o", question: "q" }]);
    expect(l.send({ type: "reply", id: "h-3", to: "panel~o", ok: true, result: { turns: [] } })).toEqual({ ok: true });
    expect(ws.json()).toEqual({ type: "reply", id: "h-3", to: "panel~o", ok: true, result: { turns: [] } });
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
    [1008, "bad_frame"],
    [1000, "replaced"],
  ])("закрытие %i %s — stopped с причиной, без переподключения", (code, reason) => {
    const { l, ws, states } = opened();
    ws.drop(code, reason);
    vi.advanceTimersByTime(120_000);
    expect(FakeWs.all.length).toBe(1);
    expect(l.state).toBe("stopped");
    expect(states.at(-1)).toEqual(["stopped", reason]);
  });

  it("7218 · closed говорит, когда следующая попытка: отсчёт страницы — от клиента связи", () => {
    // источник: гейт архитектора — пауза считается в одном месте
    const at: Array<number | undefined> = [];
    const { ws } = opened({ onState: (s: LinkState, _w?: string, retryAt?: number) => (s === "closed" ? at.push(retryAt) : undefined) });
    const t0 = Date.now();
    ws.drop(1006);
    expect(at).toEqual([t0 + 1000]);
    vi.advanceTimersByTime(1000);
    FakeWs.last().drop(1006);
    expect(at[1]).toBe(t0 + 1000 + 2000);
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
    expect(await l.request({ type: "message", to: "site@laptop" })).toMatchObject({ error: "disconnected" });
  });

  it("2057 · close во время паузы переподключения — новых сокетов нет", () => {
    const { l, ws } = opened();
    ws.drop(1006);
    expect(l.state).toBe("closed");
    l.close();
    vi.advanceTimersByTime(120_000);
    expect(FakeWs.all.length).toBe(1);
    expect(l.state).toBe("stopped");
  });
});
