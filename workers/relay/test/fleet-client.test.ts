// Эталоны клиента флота 5051–5056 на поддельных WebSocket по адресу и поддельном fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fleet, type FleetOptions, type WsLike } from "../contract.ts";

type L = Record<string, Array<(ev: any) => void>>;

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
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
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.ls.open.forEach((f) => f({}));
  }
  recv(f: unknown) {
    this.ls.message.forEach((fn) => fn({ data: JSON.stringify(f) }));
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.ls.close.forEach((fn) => fn({ code, reason }));
  }
  json(i = -1) {
    return JSON.parse(this.sent.at(i)!);
  }
  static of(machine: string) {
    return FakeWs.all.filter((w) => w.url.endsWith(`/m/${machine}`)).at(-1);
  }
}

const roster = (machine: string | null, sessions: string[] = [], clients: string[] = []) => ({
  type: "roster",
  machines: machine ? [{ machine, since: 1, proto: 1 }] : [],
  sessions: sessions.map((callsign) => ({ callsign, state: "idle" })),
  clients,
  workers: [],
});

/** fetch стенда: gate отвечает списком машин, Worker'ы — по таблице ответов. */
function stand(machines: string[], answers: Record<string, (body: any) => Response | Promise<Response>> = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    if (url === "https://gate.test/") return Response.json({ type: "reply", id: body.id, ok: true, result: { passes: machines.map((name) => ({ name })) } });
    const a = answers[url];
    if (!a) throw new Error("сеть");
    return new Promise<Response>((res, rej) => {
      init.signal?.addEventListener("abort", () => rej(new Error("abort")));
      Promise.resolve(a(body)).then(res, rej);
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function start(o: Partial<FleetOptions> & { fetch: typeof fetch }) {
  return fleet({ workers: { relay: "https://relay.test/", gate: "https://gate.test/", push: "https://push.test/" }, key: "host.win.k7f2.S", WebSocket: FakeWs, ...o });
}

/** Открыть соединение с машиной: hello принят, пришёл roster объекта. */
function up(machine: string, r = roster(machine)) {
  const ws = FakeWs.of(machine)!;
  ws.open();
  ws.recv(r);
  return ws;
}

const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("эталоны клиента флота", () => {
  it("5051 · keys.list → соединение с relay каждой машины: своя — как Host, остальные — гостем", async () => {
    const s = stand(["win", "wsl"]);
    start({ fetch: s.f, machine: "win", hello: () => ({ sdk: "0.3", sessions: [{ callsign: "site@win" }] }) });
    await tick();
    expect(s.calls[0]).toMatchObject({ url: "https://gate.test/", body: { type: "keys.list", role: "host", key: "host.win.k7f2.S" } });
    expect(FakeWs.all.map((w) => w.url).sort()).toEqual(["wss://relay.test/m/win", "wss://relay.test/m/wsl"]);
    FakeWs.of("win")!.open();
    FakeWs.of("wsl")!.open();
    expect(FakeWs.of("win")!.json(0)).toMatchObject({ type: "hello", key: "host.win.k7f2.S", sdk: "0.3", sessions: [{ callsign: "site@win" }] });
    expect(FakeWs.of("wsl")!.json(0)).toEqual({ type: "hello", key: "host.win.k7f2.S", proto: 1 });
  });

  it("5052 · в roster объекта появилась незнакомая машина → соединение с её relay", async () => {
    const s = stand(["win"]);
    start({ fetch: s.f });
    await tick();
    up("win", roster("win", [], ["phone~a@b", "@mac"]));
    expect(FakeWs.of("mac")?.url).toBe("wss://relay.test/m/mac");
    // знакомую второй раз не открывает
    FakeWs.of("win")!.recv(roster("win", [], ["@mac"]));
    expect(FakeWs.all.filter((w) => w.url.endsWith("/m/mac"))).toHaveLength(1);
  });

  it("5053 · кадр к site@wsl → в соединение wsl; к .push → POST через обёртку с пропуском", async () => {
    const s = stand(["win", "wsl"], { "https://push.test/": (b) => Response.json({ type: "reply", id: b.id, ok: true, result: { key: "K" } }) });
    const c = start({ fetch: s.f });
    await tick();
    up("win");
    const wsl = up("wsl", roster("wsl", ["site@wsl"]));
    const p = c.request({ type: "message", to: "site@wsl", text: "привет" });
    expect(wsl.json()).toMatchObject({ type: "message", to: "site@wsl" });
    wsl.recv({ type: "reply", id: wsl.json().id, ok: true });
    expect(await p).toMatchObject({ ok: true });
    expect(await c.request({ type: "push.key", v: 1, to: ".push" })).toMatchObject({ ok: true, result: { key: "K" } });
    expect(s.calls.at(-1)).toMatchObject({ url: "https://push.test/", body: { type: "push.key", to: ".push", key: "host.win.k7f2.S" } });
    // кадр без ожидания к Worker'у — тоже POST
    expect(c.send({ type: "ledger.add", to: ".push", ev: "x" })).toEqual({ ok: true });
  });

  it("5054 · связь с relay win оборвалась → запросы к wsl и к Worker'ам идут; roster флота — без win", async () => {
    const s = stand(["win", "wsl"], { "https://push.test/": (b) => Response.json({ type: "reply", id: b.id, ok: true }) });
    const c = start({ fetch: s.f, key: "client.phone.p3a1.S" });
    await tick();
    up("win", roster("win", ["a@win"]));
    const wsl = up("wsl", roster("wsl", ["b@wsl"]));
    FakeWs.of("win")!.drop(1006);
    expect(c.roster.sessions.map((x) => x.callsign)).toEqual(["b@wsl"]);
    const p = c.request({ type: "message", to: "b@wsl" });
    wsl.recv({ type: "reply", id: wsl.json().id, ok: true });
    expect(await p).toMatchObject({ ok: true });
    expect(await c.request({ type: "push.key", v: 1, to: ".push" })).toMatchObject({ ok: true });
    expect(await c.request({ type: "message", to: "a@win" })).toMatchObject({ ok: false, error: "disconnected" });
  });

  it("5055 · roster флота — объединение roster объектов машин", async () => {
    const s = stand(["win", "wsl"]);
    const c = start({ fetch: s.f, key: "client.phone.p3a1.S" });
    await tick();
    up("win", roster("win", ["a@win"], ["phone~a@b", "@wsl"]));
    up("wsl", roster("wsl", ["b@wsl"], ["phone~a@b", "pult~a@b", "@win"]));
    const r = c.roster;
    expect(r.machines.map((m) => m.machine)).toEqual(["win", "wsl"]);
    expect(r.sessions.map((x) => x.callsign)).toEqual(["a@win", "b@wsl"]);
    expect(r.clients).toEqual(["phone~a@b", "pult~a@b"]);
  });

  it("5056 · POST без ответа за предел → timeout; close() → ждущие disconnected на всех соединениях", async () => {
    const s = stand(["win"], { "https://push.test/": () => new Promise<Response>(() => {}) });
    const c = start({ fetch: s.f, requestMs: 5000 });
    await tick();
    const win = up("win", roster("win", ["a@win"]));
    const slow = c.request({ type: "push.key", v: 1, to: ".push" });
    await vi.advanceTimersByTimeAsync(5001);
    expect(await slow).toMatchObject({ ok: false, error: "timeout" });
    const hanging = c.request({ type: "push.key", v: 1, to: ".push" });
    const waiting = c.request({ type: "message", to: "a@win" });
    expect(win.sent.length).toBeGreaterThan(1);
    c.close();
    expect(await hanging).toMatchObject({ ok: false, error: "disconnected" });
    expect(await waiting).toMatchObject({ ok: false, error: "disconnected" });
    expect(await c.request({ type: "push.key", v: 1, to: ".push" })).toMatchObject({ ok: false, error: "disconnected" });
  });

  it("5058 · ответ на запрос — тем же соединением, по которому пришёл запрос: там его ждёт спросивший", async () => {
    const s = stand(["win", "wsl"]);
    const c = start({ fetch: s.f, machine: "win" });
    await tick();
    const win = up("win");
    const wsl = up("wsl", roster("wsl"));
    // Host wsl спросил гостем через объект win; ответ по адресу @wsl ушёл бы в объект wsl — туда, где его не ждут
    win.recv({ type: "session.remove", id: "q-1", from: "@wsl", callsign: "pm@win" });
    const before = wsl.sent.length;
    expect(c.send({ type: "reply", id: "q-1", ok: true, to: "@wsl" })).toEqual({ ok: true });
    expect(win.json()).toMatchObject({ type: "reply", id: "q-1", to: "@wsl" });
    expect(wsl.sent.length).toBe(before);
    // кадр, не ответ, — по адресу
    c.send({ type: "message", to: "@wsl" });
    expect(wsl.json()).toMatchObject({ type: "message", to: "@wsl" });
  });

  it("keys.list не прошёл: сбой — повтор с паузой; отказ пропуску — stopped со словом", async () => {
    let n = 0;
    const states: string[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      n++;
      return n === 1 ? Response.json({ type: "reply", id: b.id, ok: false, error: "gate_unavailable" }) : Response.json({ type: "reply", id: b.id, ok: false, error: "revoked" });
    }) as unknown as typeof fetch;
    start({ fetch: f, pauseMs: 1000, onState: (m, st, why) => states.push(`${m}:${st}:${why}`) });
    await tick();
    expect(states).toEqual([":closed:gate_unavailable"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(states).toEqual([":closed:gate_unavailable", ":stopped:revoked"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(2);
  });

  it("5171 · одна карта адресов: relay — wss адреса Worker'а relay, gate — из неё же; кадр к Worker'у без адреса — отказ offline здесь, в relay не идёт", async () => {
    // источник: отчёт слепого архитектора 2 нояб.: пункты 2 и 6 (дубликат состояния; лишняя коммуникация — «кадр к Worker'у
    // через relay не ходит» — дизайн «Открытый флот», слово пользователя «делай»)
    const s = stand(["win"]);
    const f = fleet({ workers: { relay: "https://relay.test/", gate: "https://gate.test/" }, key: "host.win.k7f2.S", WebSocket: FakeWs, fetch: s.f, machine: "win" });
    await tick();
    expect(s.calls.map((c) => c.url)).toEqual(["https://gate.test/"]);
    expect(FakeWs.all.map((w) => w.url)).toEqual(["wss://relay.test/m/win"]);
    up("win");
    const sent = FakeWs.of("win")!.sent.length;
    expect(await f.request({ type: "hello.echo", v: 1, to: ".hello-worker" })).toMatchObject({ ok: false, error: "offline" });
    expect(f.send({ type: "ledger.add", v: 1, to: ".ledger" })).toEqual({ ok: false, error: "offline" });
    expect(FakeWs.of("win")!.sent.length).toBe(sent);
  });
});
