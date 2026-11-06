// Леса границы «транслятор рации», среда Node: клиенты link и fleet через контракт на поддельном WebSocket и fetch,
// и насквозь: Node 24 (глобальный WebSocket) → relay в miniflare → настоящий gate по привязке.
// Номер — эталон-источник; свойства без пометки — чьё: код.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAME, type Frame } from "@switchboard/protocol";
import { fleet, link, PROTO, relayWs, type FleetClient, type Link, type LinkState, type WsLike } from "../contract.ts";
import { OWNER, SECRET, standPass } from "./sign.ts";

type L = Record<string, Array<(ev: any) => void>>;
type Options = Parameters<typeof fleet>[0];

/** Поддельный сокет: управление из теста — open, recv, drop. */
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
  static of(machine: string) {
    return FakeWs.all.filter((w) => w.url.endsWith(`/m/${machine}`)).at(-1);
  }
}

describe("клиент на подделках", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const rosterOf = (machines: Array<[string, number]> = [["laptop", 1], ["pc", 1]], clients = ["phone~owner@example.com"]) => ({
    type: "roster",
    machines: machines.map(([machine, since]) => ({ machine, since, proto: 1 })),
    sessions: [],
    clients,
  });

  function start(extra: Record<string, unknown> = {}) {
    const states: Array<[LinkState, string | undefined]> = [];
    const frames: any[] = [];
    const l = link({ url: "wss://relay.test", key: "client.panel-desk.k3f1.sig", WebSocket: FakeWs, onState: (s, why) => states.push([s, why]), onFrame: (f) => frames.push(f), ...extra });
    return { l, states, frames, ws: FakeWs.last() };
  }

  /** Время идёт, связь жива: на каждый ping приходит pong. */
  async function alive(ws: FakeWs, ms: number) {
    for (; ms > 0; ms -= 30_000) {
      await vi.advanceTimersByTimeAsync(Math.min(ms, 30_000));
      if (ws.sent.at(-1) === "ping") ws.recv("pong");
    }
  }

  /** Связь открыта: сокет открыт, hello ушёл, пришёл roster. */
  function opened(extra: Record<string, unknown> = {}) {
    const t = start(extra);
    t.ws.open();
    t.ws.recv(rosterOf());
    return t;
  }

  describe("link · hello", () => {
    it("первым кадром — hello с ключом, proto и полями hello(); open — после первого roster, roster и в onFrame", () => {
      const { l, ws, states, frames } = start({ hello: () => ({ sdk: "0.3.311", contract: { message: 1 }, sessions: [{ callsign: "site@laptop" }] }) });
      expect(PROTO).toBe(1);
      expect(l.state).toBe("connecting");
      expect(l.roster).toBeNull();
      ws.open();
      expect(ws.json(0)).toEqual({ type: "hello", key: "client.panel-desk.k3f1.sig", proto: PROTO, sdk: "0.3.311", contract: { message: 1 }, sessions: [{ callsign: "site@laptop" }] });
      expect(l.state).toBe("connecting");
      ws.recv(rosterOf());
      expect(l.state).toBe("open");
      expect(l.roster?.machines.map((m) => m.machine)).toEqual(["laptop", "pc"]);
      ws.recv(rosterOf());
      expect(states).toEqual([["open", undefined]]);
      expect(frames.map((f) => f.type)).toEqual(["roster", "roster"]);
    });

    it("3143 · hello без ответа — связь не висит в connecting: за предел запроса сокет закрыт 4000 no_roster, переподключение по паузе", async () => {
      // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; факт — hello теряется при смене кода relay
      const { l, ws, states } = start();
      ws.open();
      await alive(ws, 119_999);
      expect(l.state).toBe("connecting");
      await alive(ws, 1);
      expect(ws.closedWith).toEqual({ code: 4000, reason: "no_roster" });
      expect(l.state).toBe("closed");
      expect(states.at(-1)).toEqual(["closed", "no_roster"]);
      vi.advanceTimersByTime(1_000);
      const next = FakeWs.last();
      expect(next).not.toBe(ws);
      next.open();
      next.recv(rosterOf());
      await alive(next, 125_000);
      expect(l.state).toBe("open");
      expect(next.closedWith).toBeNull();
    });
  });

  describe("link · запросы", () => {
    it("запрос получает свой id и ответ с тем же id; свой id сохраняется; отказ relay — ответом, не исключением; чужой reply — в onFrame, не кадр — молча", async () => {
      const { l, ws, frames } = opened();
      const p = l.request({ type: "message", to: "poe-bot@pc", text: "hi" });
      const sent = ws.json();
      expect(sent).toMatchObject({ type: "message", to: "poe-bot@pc", text: "hi" });
      expect(typeof sent.id).toBe("string");
      ws.recv({ type: "reply", id: "чужой", ok: true });
      ws.recv("не кадр");
      ws.recv({ type: "reply", id: sent.id, ok: true, result: { done: 1 }, from: "@pc" });
      expect(await p).toMatchObject({ id: sent.id, ok: true, result: { done: 1 } });
      expect(frames.filter((f) => f.type !== "roster").map((f) => f.id)).toEqual(["чужой"]);
      const own = l.request({ type: "session.open", id: "c-7", machine: "pc" });
      expect(ws.json().id).toBe("c-7");
      ws.recv({ type: "reply", id: "c-7", ok: false, error: "offline" });
      expect(await own).toEqual({ type: "reply", id: "c-7", ok: false, error: "offline" });
    });

    it("связи нет — запрос и send сразу disconnected; очереди нет", async () => {
      const { l, ws } = start();
      ws.open();
      expect(await l.request({ type: "message", to: "site@laptop" })).toMatchObject({ ok: false, error: "disconnected" });
      expect(l.send({ type: "question", to: "phone" })).toEqual({ ok: false, error: "disconnected" });
      expect(ws.sent.length).toBe(1); // только hello
    });

    it("279 · кадр больше 32 МиБ: запрос не ушёл — ждущему too_large с байтами; ответ заменён отказом тому же адресату; прочий кадр не ушёл — too_large с байтами; соединение живо", async () => {
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
    });

    it("E1 · 3120 · 3119 · E5 · ответ потерян, связь жива: чтение — timeout ровно на 10 с, запрос-действие — на 120 с; поздний ответ — в onFrame; другие запросы не задеты", async () => {
      // источник: слово пользователя 4 нояб. «таймаут операций на запрос метадаты 10 секунд»; 120 с — вдвое выше session.open на wsl (62 с);
      // слово пользователя 2 нояб. «у всех операций должен быть лимит»; факт — Host 1.1.56 висел в stopping на github.token без ответа
      const { l, ws, frames } = opened();
      const words: string[] = [];
      const note = (x: { ok: boolean; error?: string }) => void words.push(x.error ?? "ok");
      void l.request({ type: "session.prompt", callsign: "site@laptop" }).then(note);
      const lostId = ws.json().id;
      void l.request({ type: "keeper.state", to: ".keeper@laptop" }, true).then(note);
      await alive(ws, 9_999);
      expect(words).toEqual([]);
      await alive(ws, 1);
      expect(words).toEqual(["timeout"]);
      await alive(ws, 109_999);
      const other = l.request({ type: "message", to: "site@laptop" });
      const otherId = ws.json().id;
      expect(words).toEqual(["timeout"]);
      await alive(ws, 1);
      expect(words).toEqual(["timeout", "timeout"]);
      ws.recv({ type: "reply", id: lostId, ok: true });
      expect(frames.filter((f) => f.type === "reply").map((f) => f.id)).toEqual([lostId]);
      ws.recv({ type: "reply", id: otherId, ok: true });
      expect(await other).toMatchObject({ ok: true });
      expect(l.state).toBe("open");
    });

    it("3144 · обрыв и 1012 relay_updated — ждущие сразу disconnected, не дожидаясь предела; link переподключается и входит заново", async () => {
      // источник: устав «соединение с Worker-модулем оборвалось — клиенты переподключаются»
      const { l, ws } = opened();
      const a = l.request({ type: "message", to: "site@laptop" });
      const b = l.request({ type: "keeper.state", to: ".keeper@laptop" });
      ws.drop(1012, "relay_updated");
      expect(await a).toMatchObject({ ok: false, error: "disconnected" });
      expect(await b).toMatchObject({ ok: false, error: "disconnected" });
      expect(l.state).toBe("closed");
      vi.advanceTimersByTime(1_000);
      const next = FakeWs.last();
      expect(next).not.toBe(ws);
      next.open();
      expect(next.json(0).type).toBe("hello");
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

  describe("link · правило отправителя по roster", () => {
    it("2054 · адресат ушёл из roster — ждущий запрос disconnected: машина, @машина, клиент, смена since; другая машина, часть машины и пользователь по roster не снимаются", async () => {
      const { l, ws } = opened();
      let settled = 0;
      const toPc = l.request({ type: "message", to: "poe-bot@pc" });
      const toPhone = l.request({ type: "message", to: "phone~owner@example.com" });
      const toMachine = l.request({ type: "machine.dirs", to: "@laptop" });
      const toSession = l.request({ type: "session.history", callsign: "site@laptop" });
      const toKeeper = l.request({ type: "keeper.state", to: ".keeper@laptop" });
      const keeperId = ws.json().id;
      void l.request({ type: "message", to: "~owner@example.com" }).then(() => settled++);
      void toKeeper.then(() => settled++);
      void toPc.then(() => settled++);
      ws.recv(rosterOf([["pc", 1]], []));
      expect(await toPhone).toMatchObject({ error: "disconnected" });
      expect(await toMachine).toMatchObject({ error: "disconnected" });
      expect(await toSession).toMatchObject({ error: "disconnected" });
      await Promise.resolve();
      expect(settled).toBe(0);
      ws.recv({ type: "reply", id: keeperId, ok: true });
      expect(await toKeeper).toMatchObject({ ok: true });
      ws.recv(rosterOf([["pc", 2]], []));
      expect(await toPc).toMatchObject({ error: "disconnected" });
    });
  });

  describe("link · переподключение и остановка", () => {
    it("после обрыва — closed с кодом вместо пустой причины, по паузе connecting, по roster open; roster остаётся последним известным; ping — с открытия сокета раз в 30 с", () => {
      const { l, ws, states } = opened();
      const seen = l.roster;
      ws.drop(1006);
      expect(l.roster).toBe(seen);
      vi.advanceTimersByTime(1000);
      expect(states).toEqual([["open", undefined], ["closed", "1006"], ["connecting", undefined]]);
      const next = FakeWs.last();
      next.open();
      vi.advanceTimersByTime(29_999);
      expect(next.sent.length).toBe(1);
      vi.advanceTimersByTime(1);
      expect(next.sent.at(-1)).toBe("ping");
      next.recv(rosterOf());
      expect(states.at(-1)).toEqual(["open", undefined]);
    });

    it("пауза 1, 2, 4 с; 1008 gate_unavailable — та же ветка, что обрыв; после принятого hello — снова 1 с; hello на каждом подключении", () => {
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
      FakeWs.last().drop(1008, "gate_unavailable");
      vi.advanceTimersByTime(4000);
      expect(FakeWs.all.length).toBe(4);
      const w = FakeWs.last();
      w.open();
      expect(w.json(0).n).toBe(1);
      w.recv(rosterOf());
      w.drop(1001);
      vi.advanceTimersByTime(1000);
      expect(FakeWs.all.length).toBe(5);
    });

    it.each([
      [1008, "bad_key"],
      [1000, "replaced"],
    ])("закрытие %i %s — stopped с причиной, без переподключения", (code, reason) => {
      const { l, ws, states } = opened();
      ws.drop(code, reason);
      vi.advanceTimersByTime(120_000);
      expect(FakeWs.all.length).toBe(1);
      expect(l.state).toBe("stopped");
      expect(states.at(-1)).toEqual(["stopped", reason]);
    });

    it("7218 · closed говорит, когда следующая попытка: отсчёт страницы — от клиента связи; пауза растёт до 60 с", () => {
      // источник: гейт архитектора — пауза считается в одном месте
      const pauses: number[] = [];
      const { ws } = start({ onState: (s: LinkState, _w?: string, retryAt?: number) => (s === "closed" ? pauses.push(retryAt! - Date.now()) : undefined) });
      ws.drop(1006);
      for (let i = 0; i < 7; i++) {
        vi.advanceTimersByTime(pauses.at(-1)!);
        FakeWs.last().drop(1006);
      }
      expect(pauses).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
    });

    it("ping раз в 30 с; pong — живо; нет pong к следующему ping — закрыть 4000 no_pong и переподключиться", async () => {
      const { l, ws } = opened();
      const p = l.request({ type: "message", to: "site@laptop" });
      vi.advanceTimersByTime(30_000);
      expect(ws.sent.at(-1)).toBe("ping");
      ws.recv("pong");
      vi.advanceTimersByTime(30_000);
      expect(ws.sent.at(-1)).toBe("ping");
      expect(ws.closedWith).toBeNull();
      vi.advanceTimersByTime(30_000); // pong не пришёл
      expect(ws.closedWith).toEqual({ code: 4000, reason: "no_pong" });
      expect(l.state).toBe("closed");
      expect(await p).toMatchObject({ error: "disconnected" });
      vi.advanceTimersByTime(1000);
      expect(FakeWs.all.length).toBe(2);
    });

    it("close(): ждущие disconnected, сокет закрыт с кодом и причиной, переподключений нет; по умолчанию 1000 closing", async () => {
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
      const b = opened();
      b.l.close();
      expect(b.ws.closedWith).toEqual({ code: 1000, reason: "closing" });
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

  // ---------- клиент флота ----------

  const roster = (machine: string | null, sessions: string[] = [], clients: string[] = []) => ({
    type: "roster",
    machines: machine ? [{ machine, since: 1, proto: 1 }] : [],
    sessions: sessions.map((callsign) => ({ callsign, state: "idle" })),
    clients,
  });

  /** fetch стенда: gate отвечает списком машин, Worker'ы — по таблице ответов. */
  function stand(machines: string[], answers: Record<string, (body: any) => Response | Promise<Response>> = {}, you?: string) {
    const calls: Array<{ url: string; body: any; method?: string }> = [];
    const heads: unknown[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, method: init.method });
      heads.push(init.headers);
      if (url === "https://gate.test/") return Response.json({ type: "reply", id: body.id, ok: true, result: { passes: machines.map((name) => ({ name })), you } });
      const a = answers[url];
      if (!a) throw new Error("сеть");
      return new Promise<Response>((res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("abort")));
        Promise.resolve(a(body)).then(res, rej);
      });
    }) as unknown as typeof fetch;
    return { f, calls, heads };
  }

  function client(o: Partial<Options> & { fetch: typeof fetch }): FleetClient {
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

  describe("fleet · соединения и roster", () => {
    it("5051 · keys.list → соединение с relay каждой машины: своя — как Host, остальные — гостем; адрес пропуска — от gate", async () => {
      const s = stand(["win", "wsl"], {}, "@win");
      const seen: unknown[][] = [];
      const c = client({ fetch: s.f, machine: "win", hello: () => ({ sdk: "0.3", sessions: [{ callsign: "site@win" }] }), onState: (...a) => void seen.push(a) });
      expect(c.addr).toBeNull();
      await tick();
      expect(c.addr).toBe("@win");
      // суффикс id -list — договор со стендом Host: по нему он отличает список самого клиента от keys.list модулей
      expect(s.calls[0]).toMatchObject({ url: "https://gate.test/", method: "POST", body: { type: "keys.list", id: expect.stringMatching(/-list$/), v: 1, role: "host", key: "host.win.k7f2.S" } });
      expect(FakeWs.all.map((w) => w.url).sort()).toEqual(["wss://relay.test/m/win", "wss://relay.test/m/wsl"]);
      // POST без заголовков: страница шлёт простой запрос без предзапроса (контракт gate); адрес при обрыве заново не спрашивается
      expect(s.heads).toEqual([undefined]);
      const t0 = Date.now();
      FakeWs.of("wsl")!.drop(1006);
      expect(seen.at(-1)).toEqual(["wsl", "closed", "1006", t0 + 1000]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.calls).toHaveLength(1);
      expect([...c.links().keys()].sort()).toEqual(["win", "wsl"]);
      FakeWs.of("win")!.open();
      FakeWs.of("wsl")!.open();
      expect(FakeWs.of("win")!.json(0)).toMatchObject({ type: "hello", key: "host.win.k7f2.S", sdk: "0.3", sessions: [{ callsign: "site@win" }] });
      expect(FakeWs.of("wsl")!.json(0)).toEqual({ type: "hello", key: "host.win.k7f2.S", proto: 1 });
    });

    it("5052 · в roster объекта появилась незнакомая машина → соединение с её relay, знакомую второй раз не открывает", async () => {
      const s = stand(["win"]);
      client({ fetch: s.f });
      await tick();
      up("win", roster("win", [], ["phone~a@b", "@mac"]));
      expect(FakeWs.of("mac")?.url).toBe("wss://relay.test/m/mac");
      FakeWs.of("win")!.recv(roster("win", [], ["@mac"]));
      expect(FakeWs.all.filter((w) => w.url.endsWith("/m/mac"))).toHaveLength(1);
    });

    it("5055 · 5054 · roster флота — объединение открытых объектов, гости без @машина и без повторов; связь с win оборвалась — без win", async () => {
      const s = stand(["win", "wsl"]);
      const c = client({ fetch: s.f, key: "client.phone.p3a1.S" });
      await tick();
      up("win", roster("win", ["a@win"], ["phone~a@b", "@wsl"]));
      up("wsl", roster("wsl", ["b@wsl"], ["phone~a@b", "pult~a@b", "@win"]));
      expect(c.roster.machines.map((m) => m.machine)).toEqual(["win", "wsl"]);
      expect(c.roster.sessions.map((x) => x.callsign)).toEqual(["a@win", "b@wsl"]);
      expect(c.roster.clients).toEqual(["phone~a@b", "pult~a@b"]);
      FakeWs.of("win")!.drop(1006);
      expect(c.roster.sessions.map((x) => x.callsign)).toEqual(["b@wsl"]);
    });

    it("state: у Host — своё соединение; у страницы — open, если открыто хоть одно, иначе состояние первого; после close — stopped", async () => {
      const s = stand(["win", "wsl"]);
      const host = client({ fetch: s.f, machine: "win" });
      expect(host.state).toBe("connecting");
      await tick();
      up("wsl", roster("wsl"));
      expect(host.state).toBe("connecting");
      up("win");
      expect(host.state).toBe("open");
      FakeWs.all = [];
      const page = client({ fetch: s.f, key: "client.c.k.S" });
      expect(page.state).toBe("connecting");
      await tick();
      up("win");
      up("wsl", roster("wsl"));
      FakeWs.of("win")!.drop(1008, "bad_key");
      expect(page.state).toBe("open");
      expect(page.links().get("wsl")!.state).toBe("open");
      FakeWs.of("wsl")!.drop(1006);
      expect(page.state).toBe("stopped");
      page.close();
      expect(page.state).toBe("stopped");
    });

    it("5171 · relayWs и одна карта адресов: relay — wss адреса Worker'а relay, gate — из неё же; без gate списка нет", async () => {
      // источник: отчёт слепого архитектора 2 нояб. — дубликат состояния и лишняя коммуникация
      expect(relayWs({ relay: "https://relay.test/" })).toBe("wss://relay.test");
      expect(relayWs({ relay: "http://relay.test" })).toBe("ws://relay.test");
      expect(relayWs({})).toBe("");
      const s = stand(["win"]);
      const f = fleet({ workers: { relay: "https://relay.test/", gate: "https://gate.test/" }, key: "host.win.k7f2.S", WebSocket: FakeWs, fetch: s.f, machine: "win" });
      await tick();
      expect(s.calls.map((c) => c.url)).toEqual(["https://gate.test/"]);
      expect(FakeWs.all.map((w) => w.url)).toEqual(["wss://relay.test/m/win"]);
      FakeWs.all = [];
      const calls = stand([]);
      fleet({ workers: { relay: "https://relay.test/" }, key: "k", WebSocket: FakeWs, fetch: calls.f, machine: "win" });
      await tick();
      expect(calls.calls).toEqual([]);
      expect(FakeWs.all.map((w) => w.url)).toEqual(["wss://relay.test/m/win"]);
    });

    it("keys.list не прошёл: сбой — повтор с паузой; отказ пропуску — stopped со словом", async () => {
      let n = 0;
      const states: string[] = [];
      const f = (async (_u: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body));
        n++;
        return n < 3 ? Response.json({ type: "reply", id: b.id, ok: false, error: "gate_unavailable" }) : Response.json({ type: "reply", id: b.id, ok: false, error: "bad_key" });
      }) as unknown as typeof fetch;
      const retries: Array<number | undefined> = [];
      const t0 = Date.now();
      client({ fetch: f, pauseMs: 1000, onState: (m, st, why, retryAt) => (states.push(`${m}:${st}:${why}`), retries.push(retryAt)) });
      await tick();
      expect(states).toEqual([":closed:gate_unavailable"]);
      expect(retries).toEqual([t0 + 1000]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(retries).toEqual([t0 + 1000, t0 + 3000]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(states).toEqual([":closed:gate_unavailable", ":closed:gate_unavailable", ":stopped:bad_key"]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(n).toBe(3);
    });

    it("своя машина — сразу, gate не ждёт; gate недоступен по сети — closed offline", async () => {
      const states: string[] = [];
      const c = client({ fetch: (async () => { throw new TypeError("сеть"); }) as unknown as typeof fetch, machine: "win", onState: (m, st, why) => void (m === "" && states.push(`${st}:${why}`)) });
      expect(FakeWs.all.map((w) => w.url)).toEqual(["wss://relay.test/m/win"]);
      await tick();
      expect(states).toEqual(["closed:offline"]);
      c.close();
    });

    it("E2 · список машин при подключении — чтение: gate молчит, через 10 с следующая попытка", async () => {
      // источник: дизайн «Предел чтений и слоты» — список машин при подключении тоже чтение
      let asked = 0;
      const c = fleet({
        workers: { relay: "https://relay.test/", gate: "https://gate.test/" },
        key: "client.x.k.s",
        WebSocket: FakeWs,
        pauseMs: 1,
        fetch: ((_u: string, init: RequestInit) => {
          asked++;
          return new Promise<Response>((_ok, no) => init.signal?.addEventListener("abort", () => no(new Error("aborted"))));
        }) as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(asked).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(asked).toBe(2);
      c.close();
    });

    it("7285 · список машин пуст: без своей машины onState(\"\", \"open\"), соединений нет; со своей — молчит", async () => {
      const empty = stand([]);
      const seen: Array<[string, string]> = [];
      const workers = { relay: "https://relay.test", gate: "https://gate.test/" };
      const c = fleet({ workers, key: "k", fetch: empty.f, WebSocket: FakeWs, onState: (m, s) => void seen.push([m, s]) });
      await tick();
      expect(seen).toEqual([["", "open"]]);
      expect(c.links().size).toBe(0);
      c.close();
      seen.length = 0;
      const own = fleet({ workers, key: "k", machine: "pc", fetch: empty.f, WebSocket: FakeWs, onState: (m, s) => void seen.push([m, s]) });
      await tick();
      expect(seen.filter(([m]) => m === "")).toEqual([]);
      own.close();
    });
  });

  describe("fleet · кадр по адресу", () => {
    it("5053 · кадр к site@wsl → в соединение wsl; к .push → POST с пропуском; ответ 204 — ok; без ожидания — тоже POST", async () => {
      const s = stand(["win", "wsl"], { "https://push.test/": (b) => (b.type === "push.none" ? new Response(null, { status: 204 }) : Response.json({ type: "reply", id: b.id, ok: true, result: { key: "K" } })) });
      const c = client({ fetch: s.f });
      await tick();
      up("win");
      const wsl = up("wsl", roster("wsl", ["site@wsl"]));
      const p = c.request({ type: "message", to: "site@wsl", text: "привет" });
      expect(wsl.json()).toMatchObject({ type: "message", to: "site@wsl" });
      wsl.recv({ type: "reply", id: wsl.json().id, ok: true });
      expect(await p).toMatchObject({ ok: true });
      expect(await c.request({ type: "push.key", v: 1, to: ".push" })).toMatchObject({ ok: true, result: { key: "K" } });
      expect(s.calls.at(-1)).toMatchObject({ url: "https://push.test/", body: { type: "push.key", to: ".push", key: "host.win.k7f2.S" } });
      expect(await c.request({ type: "push.none", id: "n", v: 1, to: ".push" })).toEqual({ type: "reply", id: "n", ok: true });
      expect(c.send({ type: "ledger.add", to: ".push", ev: "x" })).toEqual({ ok: true });
      await tick();
      expect(s.calls.at(-1)).toMatchObject({ url: "https://push.test/", body: { type: "ledger.add" } });
    });

    it("по callsign и machine — соединение этой машины; машины ещё нет — своё: relay доставит гостю или скажет offline; нет ни одного — offline", async () => {
      const s = stand(["win", "wsl"]);
      const c = client({ fetch: s.f, machine: "win" });
      await tick();
      const win = up("win");
      const wsl = up("wsl", roster("wsl", ["b@wsl"]));
      void c.request({ type: "budget.set", callsign: "b@wsl" });
      expect(wsl.json()).toMatchObject({ type: "budget.set", callsign: "b@wsl" });
      void c.request({ type: "machine.dirs", machine: "win" });
      expect(win.json()).toMatchObject({ type: "machine.dirs" });
      void c.request({ type: "message", to: "x@mac" });
      expect(win.json()).toMatchObject({ type: "message", to: "x@mac" });
      FakeWs.all = [];
      const none = client({ fetch: stand([]).f, key: "client.c.k.S", workers: { relay: "https://relay.test/" } });
      expect(await none.request({ type: "message", to: "x@mac" })).toMatchObject({ ok: false, error: "offline" });
      none.close();
    });

    it("соединение с машиной есть, но не открыто — disconnected, в другое не идёт; запрос со списком — своим соединением, отказ скажет relay", async () => {
      const s = stand(["win", "wsl"]);
      const c = client({ fetch: s.f, machine: "win" });
      await tick();
      const win = up("win");
      const before = win.sent.length;
      expect(await c.request({ type: "m", to: "a@wsl" })).toMatchObject({ ok: false, error: "disconnected" });
      expect(await c.request({ type: "m", to: ".keeper@wsl" })).toMatchObject({ ok: false, error: "disconnected" });
      expect(c.send({ type: "m", machine: "wsl" })).toEqual({ ok: false, error: "disconnected" });
      expect(win.sent.length).toBe(before);
      up("wsl", roster("wsl"));
      void c.request({ type: "q", to: ["a@wsl", "b@wsl"] });
      expect(win.json()).toMatchObject({ type: "q", to: ["a@wsl", "b@wsl"] });
    });

    it("устройству и человеку — своим соединением, у страницы — любым открытым; открытых нет — disconnected; адрес не разобран — решает relay, соединений нет — bad_frame", async () => {
      const s = stand(["win", "wsl"]);
      const host = client({ fetch: s.f, machine: "wsl" });
      await tick();
      up("win");
      const wsl = up("wsl", roster("wsl"));
      void host.request({ type: "note", to: "phone~a@b" });
      expect(wsl.json()).toMatchObject({ to: "phone~a@b" });
      void host.request({ type: "note", to: "~a@b" });
      expect(wsl.json()).toMatchObject({ to: "~a@b" });
      void host.request({ type: "note", to: "голое" });
      expect(wsl.json()).toMatchObject({ to: "голое" });
      void host.request({ type: "note" });
      expect(wsl.json()).toMatchObject({ type: "note" });
      FakeWs.all = [];
      const two = client({ fetch: s.f, key: "client.c.k.S" });
      await tick();
      const open = up("wsl", roster("wsl"));
      void two.request({ type: "note", to: "phone~a@b" });
      expect(open.json()).toMatchObject({ to: "phone~a@b" });
      two.close();
      const page = client({ fetch: stand([]).f, key: "client.c.k.S", workers: { relay: "https://relay.test/" } });
      expect(await page.request({ type: "note", to: "phone~a@b" })).toMatchObject({ ok: false, error: "disconnected" });
      expect(await page.request({ type: "note", to: "голое" })).toMatchObject({ ok: false, error: "bad_frame" });
      expect(await page.request({ type: "note" })).toMatchObject({ ok: false, error: "bad_frame" });
      expect(page.send({ type: "note", to: "голое" })).toEqual({ ok: false, error: "bad_frame" });
      page.close();
    });

    it("5058 · ответ на запрос — тем же соединением, по которому пришёл запрос: там его ждёт спросивший; соединение закрыто — по адресу", async () => {
      const s = stand(["win", "wsl"]);
      const c = client({ fetch: s.f, machine: "win" });
      await tick();
      const win = up("win");
      const wsl = up("wsl", roster("wsl"));
      // Host wsl спросил гостем через объект win; ответ по адресу @wsl ушёл бы в объект wsl — туда, где его не ждут
      win.recv({ type: "session.remove", id: "q-1", from: "@wsl", callsign: "pm@win" });
      const before = wsl.sent.length;
      expect(c.send({ type: "reply", id: "q-1", ok: true, to: "@wsl" })).toEqual({ ok: true });
      expect(win.json()).toMatchObject({ type: "reply", id: "q-1", to: "@wsl" });
      expect(wsl.sent.length).toBe(before);
      // id один, спросившие разные: ответ — по паре id и адрес
      wsl.recv({ type: "session.remove", id: "q-1", from: "pult~a@b", callsign: "pm@win" });
      win.recv({ type: "session.remove", id: "q-1", from: "@wsl", callsign: "pm@win" });
      c.send({ type: "reply", id: "q-1", ok: true, to: "pult~a@b" });
      expect(wsl.json()).toMatchObject({ type: "reply", id: "q-1", to: "pult~a@b" });
      // кадр, не ответ, — по адресу
      c.send({ type: "message", to: "@wsl" });
      expect(wsl.json()).toMatchObject({ type: "message", to: "@wsl" });
      win.recv({ type: "session.remove", id: "q-2", from: "@wsl", callsign: "pm@win" });
      win.drop(1006);
      expect(c.send({ type: "reply", id: "q-2", ok: true, to: "@wsl" })).toEqual({ ok: true });
      expect(wsl.json()).toMatchObject({ type: "reply", id: "q-2" });
    });

    it("список адресатов — по соединениям: каждому соединению и Worker'у один кадр со своей частью списка; один не принят — остальным ушло; никому — отказ", async () => {
      const s = stand(["win", "wsl"], { "https://push.test/": () => new Response(null, { status: 204 }) });
      const c = client({ fetch: s.f, machine: "win" });
      await tick();
      const win = up("win");
      const wsl = up("wsl", roster("wsl"));
      expect(c.send({ type: "question", to: ["a@win", "b@win", "c@wsl", "phone~a@b", ".push", ".nowhere"] })).toEqual({ ok: true });
      expect(win.json().to).toEqual(["a@win", "b@win", "phone~a@b"]);
      expect(wsl.json().to).toEqual(["c@wsl"]);
      await tick();
      expect(s.calls.at(-1)).toMatchObject({ url: "https://push.test/", body: { to: [".push"] } });
      expect(c.send({ type: "question", to: [".nowhere"] })).toEqual({ ok: false, error: "offline" });
      win.drop(1006);
      wsl.drop(1006);
      expect(c.send({ type: "question", to: ["a@win"] })).toEqual({ ok: false, error: "disconnected" });
    });

    it("5171 · кадр к Worker'у без адреса — отказ offline здесь, в relay не идёт; без ожидания — тоже", async () => {
      const s = stand(["win"]);
      const f = client({ fetch: s.f, machine: "win" });
      await tick();
      up("win");
      const sent = FakeWs.of("win")!.sent.length;
      expect(await f.request({ type: "hello.echo", v: 1, to: ".hello-worker" })).toMatchObject({ ok: false, error: "offline" });
      expect(f.send({ type: "ledger.add", v: 1, to: ".ledger" })).toEqual({ ok: false, error: "offline" });
      expect(FakeWs.of("win")!.sent.length).toBe(sent);
    });

    it("E2 · служба по HTTP молчит: read → timeout на 10 с, запрос ждёт дальше; то же к машине по соединению", async () => {
      // источник: слово пользователя 4 нояб. «таймаут операций на запрос метадаты 10 секунд»
      const s = stand(["win"], { "https://push.test/": () => new Promise<Response>(() => {}) });
      const c = client({ fetch: s.f });
      await tick();
      up("win", roster("win"));
      const words: Record<string, string> = {};
      const note = (k: string) => (x: { ok: boolean; error?: string }) => (words[k] = x.error ?? "ok");
      void c.request({ type: "push.key", v: 1, to: ".push" }, true).then(note("post read"));
      void c.request({ type: "push.send", v: 1, to: ".push" }).then(note("post request"));
      void c.request({ type: "keeper.state", v: 1, to: ".keeper@win" }, true).then(note("ws read"));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(words).toEqual({});
      await vi.advanceTimersByTimeAsync(1);
      expect(words).toEqual({ "post read": "timeout", "ws read": "timeout" });
      await vi.advanceTimersByTimeAsync(110_000);
      expect(words).toMatchObject({ "post request": "timeout" });
      c.close();
    });

    it("5542 · отказ Worker'а телом-кадром — то же слово у клиента при любом статусе, а не offline", async () => {
      // источник: устав «прямой запрос к Worker'у не прошёл — отказ словом»; бэклог «push.subscribe иногда отвечает offline»
      const words: Array<[string, number]> = [["bad_key", 200], ["gate_unavailable", 503], ["failed", 500]];
      const answers = [...words];
      const s = stand([], {
        "https://push.test/": (b) => {
          const [error, status] = answers.shift()!;
          return Response.json({ type: "reply", id: b.id, ok: false, error }, { status });
        },
      });
      const c = client({ fetch: s.f });
      await tick();
      for (const [error] of words) expect(await c.request({ type: "push.subscribe", v: 1, to: ".push" })).toMatchObject({ ok: false, error });
    });

    it("5541 · POST не дошёл — отказ offline с причиной: статус и начало тела страницы ошибки, исключение сети, тело не ответ", async () => {
      // источник: бэклог «push.subscribe иногда отвечает offline: причина теряется в post()», устав «ошибка словом, причина в журнале»
      const answers: Array<() => Promise<Response>> = [
        async () => new Response("<html>error code: 1101</html>".padEnd(300, "."), { status: 500 }),
        async () => { throw new TypeError("fetch failed"); },
        async () => new Response('{"type":"nope"}', { status: 200 }),
      ];
      const f = fleet({ workers: { push: "https://push.test/" }, key: "client.c.k.S", WebSocket: FakeWs, fetch: (() => answers.shift()!()) as never });
      for (const why of ["500: " + "<html>error code: 1101</html>".padEnd(160, "."), "TypeError: fetch failed", '200: {"type":"nope"}']) {
        expect(await f.request({ type: "push.subscribe", v: 1, to: ".push" })).toMatchObject({ ok: false, error: "offline", why });
      }
      f.close();
    });

    it("5543 · нет ответа за предел запроса — timeout с причиной, POST один, повтора нет", async () => {
      // источник: слово пользователя 2 нояб. «у всех операций лимит»; устав «отказ словом»
      const s = stand([], { "https://push.test/": () => new Promise<Response>(() => {}) });
      const c = client({ fetch: s.f });
      await tick();
      const p = c.request({ type: "push.subscribe", v: 1, to: ".push" });
      await vi.advanceTimersByTimeAsync(120_000);
      const r = (await p) as unknown as { ok: boolean; error: string; why?: string };
      expect(r).toMatchObject({ ok: false, error: "timeout" });
      expect(r.why).toBeTruthy();
      expect(s.calls.filter((x) => x.url === "https://push.test/")).toHaveLength(1);
    });

    it("кадр без ожидания к Worker'у не дошёл — onLost со словом; после close — молчит", async () => {
      const lost: Array<[string, string]> = [];
      const s = stand([], { "https://push.test/": () => Response.json({ type: "reply", id: "", ok: false, error: "bad_key" }) });
      const c = client({ fetch: s.f, onLost: (f, w) => void lost.push([f.type, w]) });
      await tick();
      expect(c.send({ type: "push.send", v: 1, to: ".push" })).toEqual({ ok: true });
      await tick();
      expect(lost).toEqual([["push.send", "bad_key"]]);
      expect(c.send({ type: "push.send", v: 1, to: ".push" })).toEqual({ ok: true });
      c.close();
      await tick();
      expect(lost).toHaveLength(1);
    });

    it("5056 · 5544 · close(): ждущие disconnected сразу на всех соединениях и POST; новый запрос — disconnected без POST; пауза списка снята", async () => {
      // источник: устав «останавливается штатно: не принимает новое»; слово пользователя 2 нояб. «лимит и graceful shutdown»
      const s = stand(["win"], { "https://push.test/": () => new Promise<Response>(() => {}) });
      const c = client({ fetch: s.f });
      await tick();
      const win = up("win", roster("win", ["a@win"]));
      const hanging = c.request({ type: "push.key", v: 1, to: ".push" });
      const waiting = c.request({ type: "message", to: "a@win" });
      expect(win.sent.length).toBeGreaterThan(1);
      await tick();
      c.close(1000, "shutting_down");
      expect(await hanging).toMatchObject({ ok: false, error: "disconnected" });
      expect(await waiting).toMatchObject({ ok: false, error: "disconnected" });
      expect(win.closedWith).toEqual({ code: 1000, reason: "shutting_down" });
      const posts = s.calls.filter((x) => x.url === "https://push.test/").length;
      expect(await c.request({ type: "push.key", v: 1, to: ".push" })).toMatchObject({ ok: false, error: "disconnected" });
      expect(c.send({ type: "x", to: ".push" })).toEqual({ ok: false, error: "disconnected" });
      expect(c.send({ type: "x", to: "a@win" })).toEqual({ ok: false, error: "disconnected" });
      await tick();
      expect(s.calls.filter((x) => x.url === "https://push.test/")).toHaveLength(posts);
      let n = 0;
      const down = fleet({ workers: { relay: "https://relay.test/", gate: "https://gate.test/" }, key: "k", WebSocket: FakeWs, pauseMs: 1000, fetch: (async () => (n++, Response.json({ type: "reply", id: "", ok: false, error: "gate_unavailable" }))) as never });
      await tick();
      down.close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(n).toBe(1);
    });
  });
});

describe("насквозь через relay и gate", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundle = (entry: string) => buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["cloudflare:workers"], write: false }).outputFiles[0].text;
  /** адрес устройства владельца флота: пропуска клиентов выданы ему */
  const dev = (n: string) => `${n}~${OWNER}`;

  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  /** пропуск стенда в базе gate */
  const sign = (secret: string, role: "host" | "client", name: string, kid: string) => standPass(db, role, name, kid, secret);
  let url: string;
  const links: Link[] = [];

  beforeAll(async () => {
    mf = new Miniflare(convertV4MiniflareOptions({
      workers: [
        {
          name: "switchboard",
          modules: true,
          script: bundle(join(here, "..", "src", "index.ts")),
          compatibilityDate: "2026-08-01",
          durableObjects: { FLEET: { className: "Fleet", useSQLite: true } },
          serviceBindings: { GATE: { name: "switchboard-gate", entrypoint: "Gate" } },
          bindings: { PROTO: [1] },
        },
        {
          name: "switchboard-gate",
          modules: true,
          script: bundle(join(here, "..", "..", "gate", "src", "index.ts")),
          compatibilityDate: "2026-08-01",
          d1Databases: { DB: "gate-db" },
        },
      ],
    }));
    // объект машины laptop: Host laptop — свой, остальные — гости
    url = (await mf.ready).href.replace(/^http/, "ws") + "m/laptop";
    // схема базы gate: пропуска стенда кладутся прямо в неё
    db = await mf.getD1Database("DB", "switchboard-gate");
    const sql = readFileSync(join(here, "..", "..", "gate", "migrations", "0001_passes.sql"), "utf8").replace(/--.*$/gm, "");
    for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  }, 60_000);

  afterAll(async () => {
    for (const l of links) l.close();
    await mf?.dispose();
  });

  async function until<T>(get: () => T | undefined | false, ms = 5000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = get();
      if (v) return v;
      if (Date.now() > end) throw new Error("не дождались");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function open(key: string, hello?: () => Record<string, unknown>, onFrame?: (f: Frame) => void) {
    const states: Array<[LinkState, string | undefined]> = [];
    const l = link({ url, key, hello, onFrame, onState: (s, why) => states.push([s, why]), pauseMs: 100 });
    links.push(l);
    return { l, states };
  }

  it("Host и пульт: запрос по callsign, ответ Host по from; уход Host — ждущий запрос disconnected", async () => {
    const hostFrames: Frame[] = [];
    const host = open(
      await sign(SECRET, "host", "laptop", "k7f3"),
      () => ({ sdk: "0.3.311", contract: { "session.history": 1 }, sessions: [{ callsign: "site@laptop", state: "idle" }] }),
      (f) => hostFrames.push(f),
    );
    await until(() => host.l.state === "open");
    const panel = open(await sign(SECRET, "client", "panel-desk", "k3f1"));
    await until(() => panel.l.state === "open" && panel.l.roster?.machines.length === 1);
    expect(panel.l.roster?.sessions).toEqual([{ callsign: "site@laptop", state: "idle" }]);
    expect(panel.l.roster?.machines[0]).toMatchObject({ machine: "laptop", proto: 1, sdk: "0.3.311", contract: { "session.history": 1 } });

    const p = panel.l.request({ type: "session.history", callsign: "site@laptop" });
    const req = await until(() => hostFrames.find((f) => f.type === "session.history"));
    expect(req.from).toBe(dev("panel-desk"));
    expect(host.l.send({ type: "reply", id: req.id!, to: req.from, ok: true, result: { turns: 3 } })).toEqual({ ok: true });
    expect(await p).toMatchObject({ ok: true, result: { turns: 3 }, from: "@laptop" });

    // адресата нет — offline от relay
    expect(await panel.l.request({ type: "session.open", machine: "pc" })).toMatchObject({ ok: false, error: "offline" });

    // Host ушёл, пока пульт ждал — disconnected по roster
    const waiting = panel.l.request({ type: "session.history", callsign: "site@laptop" });
    await until(() => hostFrames.filter((f) => f.type === "session.history").length === 2);
    host.l.close(1000, "shutting_down");
    expect(await waiting).toMatchObject({ ok: false, error: "disconnected" });
    expect(host.states.at(-1)).toEqual(["stopped", "shutting_down"]);
  }, 30_000);

  it("отказ gate и вытеснение — stopped со словом, без переподключений", async () => {
    const bad = open(await sign("чужой", "client", "phone", "k8e1"));
    await until(() => bad.l.state === "stopped");
    expect(bad.states.at(-1)).toEqual(["stopped", "bad_key"]);
    const key = await sign(SECRET, "host", "pc", "m3d1");
    const first = open(key);
    await until(() => first.l.state === "open");
    const second = open(key);
    await until(() => first.l.state === "stopped");
    expect(first.states.at(-1)).toEqual(["stopped", "replaced"]);
    expect(second.l.state).toBe("open");
  }, 30_000);
});
