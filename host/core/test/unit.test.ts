// Юнит-тесты частей ядра и договора модуля на стенде.
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refuse } from "../contract.ts";
import type { Host, Module } from "../contract.ts";
import { parseKeeperLine } from "../src/keeper.ts";
import { InputQueue } from "../src/queue.ts";
import { gate } from "../src/registry.ts";
import { loadRelease } from "../src/release.ts";
import { Stores } from "../src/store.ts";
import { CORE, FakeClock, msg, module, standHost, until } from "../stand/index.ts";
import type { Stand } from "../stand/index.ts";

const stands: Stand[] = [];
async function stand(o: Parameters<typeof standHost>[0] = {}): Promise<Stand> {
  const st = await standHost(o);
  stands.push(st);
  return st;
}
afterEach(async () => {
  for (const st of stands.splice(0)) await st.close();
});

describe("хранилище", () => {
  it("разделы машины и сессии; запись сразу целым JSON; remove стирает разделы сессии у всех", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-store-"));
    const s = new Stores(dir);
    s.machine<string[]>("host-slots").set(["y0902"]);
    s.session<number>("host-cost", "site@laptop").set(1);
    s.session<number>("host-cost", "wiki@laptop").update((c = 0) => c + 2);
    s.session<string>("host-slots", "site@laptop").set("main");
    expect(JSON.parse(readFileSync(join(dir, "host-cost.json"), "utf8"))).toEqual({ sessions: { "site@laptop": 1, "wiki@laptop": 2 } });
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    s.removeSession("site@laptop");
    const fresh = new Stores(dir);
    expect(fresh.session("host-cost", "site@laptop").get()).toBeUndefined();
    expect(fresh.session("host-cost", "wiki@laptop").get()).toBe(2);
    expect(fresh.machine("host-slots").get()).toEqual(["y0902"]);
    expect(fresh.session("host-slots", "site@laptop").get()).toBeUndefined();
  });

  it("get отдаёт копию: правка без set не меняет раздел", () => {
    const s = new Stores(mkdtempSync(join(tmpdir(), "sb-store-")));
    s.machine<{ a: number }>("m").set({ a: 1 });
    s.machine<{ a: number }>("m").get()!.a = 5;
    expect(s.machine("m").get()).toEqual({ a: 1 });
  });
});

describe("очередь ввода", () => {
  it("новый поток забирает очередь, прежний больше ничего не берёт", async () => {
    const q = new InputQueue();
    const m = (t: string) => ({ type: "user" as const, message: { role: "user" as const, content: t }, parent_tool_use_id: null });
    const a = q.stream()[Symbol.asyncIterator]();
    q.push(m("1"));
    expect((await a.next()).value.message.content).toBe("1");
    const pendingA = a.next();
    const b = q.stream()[Symbol.asyncIterator]();
    q.push(m("2"));
    expect((await b.next()).value.message.content).toBe("2");
    const raced = await Promise.race([pendingA.then(() => "a"), new Promise((r) => setTimeout(() => r("ничего"), 20))]);
    expect(raced).toBe("ничего");
  });
});

describe("гейт старта Host", () => {
  const e = (name: string, mod: Module, extra: Parameters<typeof module>[2] = {}) => module(name, mod, extra);
  it("обработчик не из provides, имя ядра в fields, calls мимо SDK и метод ядра, два decide, keeper spawn, Worker без relay", () => {
    const bad = e("host-a", { requests: { x: () => 1 } }, { provides: {} });
    bad.manifest.provides = {};
    const errors = gate(
      CORE,
      [
        bad,
        e("host-b", { fields: { state: () => 1 } }),
        e("host-c", {}, { calls: ["getContextUsage", "close", "nope"] }),
        e("host-q1", { decide: { AskUserQuestion: () => ({ behavior: "allow" }) } }),
        e("host-q2", { decide: { AskUserQuestion: () => ({ behavior: "allow" }) } }),
        e("host-k", {}, { uses: { "spawn@keeper": 1, "list@keeper": 1 } }),
        e("host-p", {}, { uses: { "push.send@push": 1 } }),
      ],
      false,
    );
    expect(errors).toEqual([
      "host-k: spawn@keeper — эту операцию keeper зовёт только ядро",
      "host-p: push.send@push — relay нет в host.json",
      "host-a: requests.x — нет в provides",
      "host-b: поле state — имя ядра",
      "host-c: calls close — метод держит ядро",
      "host-c: calls nope — такого метода нет в SDK",
      "decide AskUserQuestion: два владельца — host-q1 и host-q2",
    ]);
  });

  it("годный набор: Worker-имя через relay, keeper list и upgrade, uses между модулями той же версии", () => {
    const errors = gate(
      CORE,
      [
        e("host-watch", { requests: { "session.watchers": () => [] } }),
        e("host-questions", {}, { uses: { "session.watchers@host-watch": 1, "roster@relay": 1, "upgrade@keeper": 1, "list@keeper": 1, "host.module@host": 1 }, calls: ["enableRemoteControl", "getSessionMessages"] }),
      ],
      true,
    );
    expect(errors).toEqual([]);
  });
});

describe("keeper и выпуск", () => {
  it("строка keeper из ввода Host", () => {
    expect(parseKeeperLine('{"keeper":"127.0.0.1:51873","key":"c1d9"}')).toEqual({ host: "127.0.0.1", port: 51873, key: "c1d9" });
    expect(() => parseKeeperLine('{"keeper":"127.0.0.1:1"}')).toThrow();
  });

  it("выпуск монорепо: ядро, SDK 0.3.311 и список модулей", async () => {
    const r = await loadRelease(join(import.meta.dirname, ".."));
    expect(r).toMatchObject({ core: "1.0.0", sdk: "0.3.311", version: "1.0.0" });
    expect(Array.isArray(r.modules)).toBe(true);
  });

  it("поддельные часы: таймеры по порядку только по advance", () => {
    const c = new FakeClock(0);
    const got: number[] = [];
    c.setTimeout(() => got.push(2), 20);
    const h = c.setTimeout(() => got.push(3), 30);
    c.setTimeout(() => got.push(1), 10);
    c.clearTimeout(h);
    c.advance(25);
    expect(got).toEqual([1, 2]);
    expect(c.now()).toBe(25);
  });
});

describe("договор модуля на стенде", () => {
  it("host.request: своё имя и имя модуля этой машины — в процессе; keeper list; Worker-модуль — в relay с to; другая машина — по callsign", async () => {
    let host!: Host;
    const watch = module("host-watch", { requests: { "session.watchers": (req, ctx) => ({ from: ctx.from, cs: req.callsign }) } });
    const q = module("host-questions", { start: (h) => void (host = h), requests: { answer: () => "own" } }, {
      uses: { "session.watchers@host-watch": 1, "list@keeper": 1, "push.send@push": 1, "session.watchers@host-watch2": 1 },
    });
    q.manifest.uses = { "session.watchers@host-watch": 1, "list@keeper": 1, "push.send@push": 1 };
    const st = await stand({ modules: [watch, q] });
    await st.open("site@laptop");
    expect(await host.request("session.watchers", { v: 1, callsign: "site@laptop" })).toEqual({ ok: true, result: { from: "@laptop", cs: "site@laptop" } });
    expect(await host.request("answer", { v: 1 })).toEqual({ ok: true, result: "own" });
    expect(await host.request("list", { v: 1 })).toMatchObject({ ok: true, result: { processes: [{ id: "site@laptop" }] } });
    const push = host.request("push.send", { v: 1, clients: ["phone"] });
    await until(() => st.relay.frames("push.send").length === 1);
    const f = st.relay.frames("push.send")[0];
    expect(f).toMatchObject({ type: "push.send", v: 1, to: "push" });
    st.relay.deliver({ type: "reply", id: f.id, ok: false, error: "offline" });
    expect(await push).toEqual({ ok: false, error: "offline" });
    const remote = host.request("session.watchers", { v: 1, callsign: "api@pc" });
    await until(() => st.relay.frames("session.watchers").length === 1);
    const g = st.relay.frames("session.watchers")[0];
    expect(g.to).toBeUndefined();
    st.relay.deliver({ type: "reply", id: g.id, ok: true, result: [] });
    expect(await remote).toEqual({ ok: true, result: [] });
  });

  it("refuse(слово) — reply с этим словом и refuse в журнале, модуль не выключен", async () => {
    const q = module("host-questions", {
      requests: {
        answer: () => {
          throw refuse("already_answered", "вопрос toolu_1 закрыт");
        },
      },
    });
    const st = await stand({ modules: [q] });
    await st.open("site@laptop");
    for (let i = 0; i < 2; i++) expect(await st.relay.request({ type: "answer", v: 1, callsign: "site@laptop" })).toMatchObject({ ok: false, error: "already_answered" });
    expect(st.journal().filter((l) => l.ev === "request" && l.word === "already_answered")).toHaveLength(2);
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });

  it("запрос без callsign падает — модуль выключен на машине, failed во всех сессиях; имени нет — unknown_request", async () => {
    const m = module("host-x", { requests: { "x.do": () => { throw new Error("бах"); } } });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    await st.open("wiki@laptop");
    expect(await st.relay.request({ type: "x.do", v: 1, machine: "laptop" })).toMatchObject({ error: "module_error" });
    for (const cs of ["site@laptop", "wiki@laptop"]) await until(() => (st.states(cs).at(-1)?.failed as Record<string, string>)?.["host-x"]);
    expect(await st.relay.request({ type: "y.do", v: 1 })).toMatchObject({ error: "unknown_request" });
  });

  it("регрессия: запрос модуля этой машины с callsign ещё не открытой сессии доставляется владельцу; от клиента через relay — offline", async () => {
    let host!: Host;
    const slots = module("host-slots", { requests: { "session.slot": (req, ctx) => ({ cs: req.callsign, live: !!ctx.host.session(req.callsign as string) }) } });
    const manage = module("host-manage", { start: (h) => void (host = h) }, { uses: { "session.slot@host-slots": 1 } });
    const st = await stand({ modules: [slots, manage] });
    expect(await host.request("session.slot", { v: 1, callsign: "board@laptop", slot: "main" })).toEqual({ ok: true, result: { cs: "board@laptop", live: false } });
    expect(await st.relay.request({ type: "session.slot", v: 1, callsign: "board@laptop" })).toMatchObject({ ok: false, error: "offline" });
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });

  it("регрессия: запрос модуля о сессии, которой нет, — сбой владельца даёт module_error, модуль на машине не выключен (живой прогон 31 окт.)", async () => {
    let host!: Host;
    const manage = module("host-manage", {
      requests: {
        "session.spec": (req, ctx) => ({ dir: ctx.host.session(req.callsign as string)!.info.cwd }),
        "session.remove": () => ({ removed: true }),
      },
    });
    const points = module("host-points", { start: (h) => void (host = h) }, { uses: { "session.spec@host-manage": 1, "session.remove@host-manage": 1 } });
    const st = await stand({ modules: [manage, points] });
    await st.open("site@laptop");
    expect(await host.request("session.spec", { v: 1, callsign: "gone@laptop" })).toMatchObject({ ok: false, error: "module_error" });
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
    expect(await host.request("session.spec", { v: 1, callsign: "site@laptop" })).toMatchObject({ ok: true });
    expect(await st.relay.request({ type: "session.remove", v: 1, callsign: "site@laptop" })).toMatchObject({ ok: true });
  });

  it("регрессия: renameSession живой сессии — метод query с её session_id; остановленной — функция SDK с папкой", async () => {
    const m = module("host-manage", {}, { calls: ["renameSession"] });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    const s = st.session("host-manage", "site@laptop")!;
    await s.sdk("renameSession", "Сайт");
    expect(st.query("site@laptop").calls.at(-1)).toEqual({ name: "renameSession", args: ["Сайт", s.info.session_id] });
    expect(st.sdk.fnCalls).toEqual([]);
    await s.stop();
    await s.sdk("renameSession", "Старый");
    expect(st.sdk.fnCalls).toEqual([{ name: "renameSession", args: [s.info.session_id, "Старый", { dir: s.info.cwd }] }]);
  });

  it("регрессия: session() уже видит вид старта и point — host.open spawn и point, старт Host attach и resume, s.start resume; асинхронный session()", async () => {
    const seen: string[] = [];
    const remote = module("host-remote", {
      session: async (s) => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`${s.info.callsign} ${s.info.start}${s.info.point !== undefined ? " " + s.info.point : ""}`);
        return { append: `start ${s.info.start}` };
      },
    });
    const { FakeKeeper } = await import("../stand/index.ts");
    const k = await new FakeKeeper().listen();
    const st = await stand({ keeper: k, modules: [remote] });
    await st.open("site@laptop");
    await st.kernel.open({ callsign: "back@laptop", cwd: st.home, resume: "sid-back", point: 318 });
    const s = st.session("host-remote", "site@laptop")!;
    await s.stop();
    await s.start();
    expect(seen).toEqual(["site@laptop spawn", "back@laptop point 318", "site@laptop resume"]);
    expect((st.query("back@laptop").options.systemPrompt as { append: string }).append).toBe("start point");
    st.crash();
    k.procs.get("back@laptop")!.exit(1, "умер без Host");
    seen.length = 0;
    const st2 = await stand({ keeper: k, home: st.home, modules: [remote] });
    expect(seen.sort()).toEqual(["back@laptop resume", "site@laptop attach"]);
    await st2.close();
    await k.close();
  });

  it("регрессия: отказ словом из другой копии пакета (после host.reload) — по метке, не ошибка модуля", async () => {
    const foreign = Object.assign(new Error("already_answered"), { word: "already_answered", [Symbol.for("switchboard.refusal")]: true });
    const q = module("host-questions", { requests: { answer: () => { throw foreign; } } });
    const st = await stand({ modules: [q] });
    expect(await st.relay.request({ type: "answer", v: 1 })).toMatchObject({ ok: false, error: "already_answered" });
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });

  it("регрессия: s.refresh() — поле вне событий SDK уходит в session.state сразу", async () => {
    let url: string | null = null;
    let sess!: import("../contract.ts").Session;
    const remote = module("host-remote", { fields: { remote: () => url }, on: { open: (s) => void (sess = s) } });
    const st = await stand({ modules: [remote] });
    await st.open("site@laptop");
    const before = st.states("site@laptop").length;
    url = "https://claude.ai/code/session_x";
    sess.refresh();
    sess.refresh();
    expect(st.states("site@laptop").length).toBe(before + 1);
    await until(() => st.states("site@laptop").at(-1)?.remote === "https://claude.ai/code/session_x");
  });

  it("регрессия: отказ Worker-модуля через relay несёт все поля reply без конверта; отказ keeper — без op", async () => {
    let host!: Host;
    const pts = module("host-points", { start: (h) => void (host = h) }, { uses: { "points.put@points": 1, "upgrade@keeper": 1 } });
    const st = await stand({ modules: [pts] });
    const put = host.request("points.put", { v: 1, callsign: "site@laptop", seq: 3 });
    await until(() => st.relay.frames("points.put").length === 1);
    const f = st.relay.frames("points.put")[0];
    st.relay.deliver({ type: "reply", id: f.id, from: "points", to: "@laptop", ok: false, error: "not_owner", owner: "pc", missing: [1, 2] });
    expect(await put).toEqual({ ok: false, error: "not_owner", owner: "pc", missing: [1, 2] });
    const ok = host.request("points.put", { v: 1, callsign: "site@laptop", seq: 4 });
    await until(() => st.relay.frames("points.put").length === 2);
    st.relay.deliver({ type: "reply", id: st.relay.frames("points.put")[1].id, from: "points", ok: true, result: { seq: 4 } });
    expect(await ok).toEqual({ ok: true, result: { seq: 4 } });
  });

  it("регрессия: calls — все методы Query SDK 0.3.311, включая usage_EXPERIMENTAL…; стенд их записывает", async () => {
    const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
    const { readFileSync: rf } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const d = rf(join(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"), "..", "sdk.d.ts"), "utf8");
    const q = d.slice(d.indexOf("export declare interface Query extends"));
    const methods = [...q.slice(0, q.search(/\r?\n\}/)).matchAll(/^    ([a-zA-Z_]+)\(/gm)].map((m) => m[1]);
    const { CORE_ONLY, QUERY_METHODS } = await import("../src/calls.ts");
    expect(methods).toContain(USAGE);
    expect(methods.filter((m) => !QUERY_METHODS.has(m) && !CORE_ONLY.has(m))).toEqual([]);
    const acc = module("host-accounts", {}, { calls: [USAGE, "claudeOAuthWaitForCompletion", "claudeAuthenticate"] });
    const st = await stand({ modules: [acc] });
    expect(st.startError).toBeNull();
    const p = st.host("host-accounts").probe({ env: {} });
    await p.sdk(USAGE);
    await p.sdk("claudeOAuthWaitForCompletion");
    expect(st.sdk.queries.at(-1)!.calls.map((c) => c.name)).toEqual([USAGE, "claudeOAuthWaitForCompletion"]);
  });

  it("кадры: владельцу по type; roster — в on.frame тем, у кого roster@relay в uses", async () => {
    const got: string[] = [];
    const fleet = module("host-fleet", { frames: { message: (f) => void got.push(`message ${f.text}`) }, on: { frame: (f) => void got.push(`fleet ${f.type}`) } }, { uses: { "roster@relay": 1 } });
    const other = module("host-chat", { on: { frame: (f) => void got.push(`chat ${f.type}`) } });
    const st = await stand({ modules: [fleet, other] });
    got.length = 0; // roster после hello уже пришёл
    st.relay.deliver({ type: "message", to: "site@laptop", from: "poe-bot@pc", text: "привет" });
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [], workers: [] });
    await until(() => got.length === 2);
    expect(got).toEqual(["message привет", "fleet roster"]);
  });

  it("host.emit: своё имя — в relay; чужое без uses — ошибка модуля; связи нет — disconnected", async () => {
    let host!: Host;
    const q = module("host-questions", { start: (h) => void (host = h) }, { provides: { question: 1 } });
    const st = await stand({ modules: [q] });
    expect(host.emit({ type: "question", to: ["phone"], question: "toolu_1" })).toEqual({ ok: true });
    await until(() => st.relay.frames("question").length === 1);
    expect(() => host.emit({ type: "message", to: "x@pc" })).toThrow("message нет в provides и uses");
    const st2 = await stand({ modules: [q], relay: false });
    expect(st2.host("host-questions").emit({ type: "question" })).toEqual({ ok: false, error: "disconnected" });
  });

  it("s.sdk: метод query и функция SDK сессии с её id и папкой; host.probe и host.cli", async () => {
    const m = module("host-manage", {}, { calls: ["getContextUsage", "renameSession", "getSessionMessages", "claudeAuthenticate"] });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    const s = st.session("host-manage", "site@laptop")!;
    await s.sdk("getContextUsage");
    expect(st.query("site@laptop").calls.at(-1)).toEqual({ name: "getContextUsage", args: [] });
    await s.sdk("getSessionMessages", { limit: 5 });
    expect(st.sdk.fnCalls).toEqual([{ name: "getSessionMessages", args: [s.info.session_id, { dir: s.info.cwd, limit: 5 }] }]);
    const host = st.host("host-manage");
    const p = host.probe({ env: { CLAUDE_CONFIG_DIR: "/acc/y0902" } });
    await p.sdk("claudeAuthenticate", true);
    const pq = st.sdk.queries.at(-1)!;
    expect(pq.options.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/acc/y0902", DISABLE_UPDATES: "1" });
    expect(pq.options.spawnClaudeCodeProcess).toBeUndefined();
    expect(pq.calls.at(-1)).toEqual({ name: "claudeAuthenticate", args: [true] });
    p.close();
    await host.cli(["auth", "status"], { env: { CLAUDE_CONFIG_DIR: "/acc/y0902" } });
    expect(st.sdk.cliCalls[0]).toMatchObject({ args: ["auth", "status"], env: { CLAUDE_CONFIG_DIR: "/acc/y0902", DISABLE_UPDATES: "1" } });
  });

  it("вклады в query(): env, append, settings, mcpServers, опция; режим «разрешено всё»; DISABLE_UPDATES; два владельца env — open отказан", async () => {
    const slots = module("host-slots", { session: () => ({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/slots/main" }, settings: { theme: "dark" } }) });
    const fleet = module("host-fleet", { session: (s) => ({ append: `Твой callsign — ${s.info.callsign}.`, mcpServers: { fleet: { type: "sdk", name: "fleet" } as never }, model: "claude-haiku-4-5" }) });
    const st = await stand({ modules: [slots, fleet] });
    await st.open("site@laptop");
    const o = st.query("site@laptop").options;
    expect(o).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: "claude-haiku-4-5",
      settings: { theme: "dark" },
      mcpServers: { fleet: { type: "sdk", name: "fleet" } },
      systemPrompt: { type: "preset", preset: "claude_code", append: "Твой callsign — site@laptop." },
    });
    // без CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS SDK не шлёт session_state_changed — состояние сессии в roster стоит (живой прогон 31 окт.)
    expect(o.env).toMatchObject({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/slots/main", DISABLE_UPDATES: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" });
    expect(o.sessionId).toBe(st.kernel.sessions.get("site@laptop")!.rec.session_id);

    const dup = module("host-dup", { session: () => ({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/x" } }) });
    const st2 = await stand({ modules: [slots, dup] });
    await expect(st2.open("site@laptop")).rejects.toThrow("env CLAUDE_SECURESTORAGE_CONFIG_DIR: два владельца — host-slots и host-dup");
    expect(st2.kernel.sessions.size).toBe(0);

    const thief = module("host-thief", { session: () => ({ permissionMode: "default" }) });
    const st3 = await stand({ modules: [thief] });
    await st3.open("site@laptop");
    expect(st3.query("site@laptop").options.permissionMode).toBe("bypassPermissions");
    expect(st3.states("site@laptop").at(-1)!.failed).toMatchObject({ "host-thief": "опция permissionMode — её держит ядро · session" });
  });

  it("s.stop, s.start({ point }), s.remove: state, keeper kill, resume, разделы стёрты, state null в relay", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const m = module("host-manage", { on: { open: (s) => void opened.push(s.info.start), close: (s) => void closed.push(s.info.callsign) } });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    const s = st.session("host-manage", "site@laptop")!;
    s.store().set({ spec: 1 });
    await s.stop();
    expect(s.state).toBe("stopped");
    expect(st.kernel.sessions.get("site@laptop")!.rec.stopped).toBe(true);
    expect(st.keeper.procs.has("site@laptop")).toBe(false);
    await s.start({ point: 318 });
    expect(s.info).toMatchObject({ start: "point", point: 318 });
    expect(st.query("site@laptop").options.resume).toBe(s.info.session_id);
    await s.remove();
    expect(st.kernel.sessions.has("site@laptop")).toBe(false);
    expect(st.relay.frames("session.state").at(-1)).toEqual({ type: "session.state", callsign: "site@laptop", state: null });
    expect(JSON.parse(readFileSync(join(st.home, "store", "host-manage.json"), "utf8")).sessions).toEqual({});
    expect(opened).toEqual(["spawn", "point"]);
    expect(closed).toEqual(["site@laptop", "site@laptop"]);
    expect(JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")).sessions).toEqual([]);
  });

  it("host.open с resume и fork: новый session_id от того же разговора", async () => {
    const st = await stand({ modules: [] });
    const s = await st.kernel.open({ callsign: "copy@laptop", cwd: st.home, resume: "orig-id", fork: true });
    const o = st.query("copy@laptop").options;
    expect(o).toMatchObject({ resume: "orig-id", forkSession: true, sessionId: s.rec.session_id });
    expect(s.rec.session_id).not.toBe("orig-id");
    await expect(st.kernel.open({ callsign: "copy@pc", cwd: st.home })).rejects.toThrow("не этой машины");
  });

  it("elicit: владелец решает форму; владельца нет — decline", async () => {
    const m = module("host-questions", { elicit: (_s, req) => ({ action: "accept", content: { project: String((req as { message: string }).message) } }) });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    expect(await st.proc("site@laptop").elicit({ serverName: "jira", message: "SB", mode: "form" })).toEqual({ action: "accept", content: { project: "SB" } });
    const st2 = await stand({ modules: [] });
    await st2.open("site@laptop");
    expect(await st2.proc("site@laptop").elicit({ serverName: "jira", message: "x" })).toEqual({ action: "decline" });
  });

  it("start() модуля бросил на старте Host: выключен на машине, failed в roster, Host работает", async () => {
    const bad = module("host-bad", { start: () => { throw new Error("нет конфига"); }, requests: { "bad.x": () => 1 } });
    const st = await stand({ modules: [bad] });
    expect(st.startError).toBeNull();
    await st.open("site@laptop");
    expect(st.states("site@laptop").at(-1)!.failed).toEqual({ "host-bad": "нет конфига · start" });
    expect(await st.relay.request({ type: "bad.x", v: 1 })).toMatchObject({ error: "module_error" });
  });

  it("журнал: строка JSON на запись, t по часам ядра, part host, who — модуль", async () => {
    let host!: Host;
    const m = module("host-journal", { start: (h) => void (host = h) });
    const st = await stand({ modules: [m] });
    host.log({ kind: "note", ev: "sdk.result", callsign: "site@laptop" });
    const l = st.journal().find((x) => x.ev === "sdk.result")!;
    expect(l).toEqual({ t: "2026-10-30T14:00:00.000Z", part: "host", machine: "laptop", who: "host-journal", kind: "note", ev: "sdk.result", callsign: "site@laptop" });
    expect(existsSync(join(st.home, "journal", "host-2026-10-30.jsonl"))).toBe(true);
  });

  it("процесс, которого нет в списке сессий, — kill и строка в журнале", async () => {
    const { FakeKeeper } = await import("../stand/index.ts");
    const k = await new FakeKeeper().listen();
    const orphan = k.addProcess("ghost@laptop");
    const st = await stand({ keeper: k, modules: [] });
    expect(orphan.alive).toBe(false);
    expect(st.journal().some((l) => l.ev === "orphan_kill" && l.callsign === "ghost@laptop")).toBe(true);
    await st.close();
    await k.close();
  });

  it("поле roster собирается после каждого сообщения SDK; не изменилось — session.state не шлётся", async () => {
    let n = 0;
    const m = module("host-count", { fields: { count: () => n }, on: { event: (_s, x) => void (x.type === "assistant" && n++) } });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    const before = st.states("site@laptop").length;
    const p = st.proc("site@laptop");
    p.send(msg.assistant("a"));
    p.send(msg.init("sid"));
    p.send(msg.assistant("b"));
    await until(() => st.states("site@laptop").at(-1)?.count === 2);
    expect(st.states("site@laptop").length).toBe(before + 2);
  });

  it("перезапуск до первого хода: файла разговора нет — тот же id заново, а не resume; копия — снова копией", async () => {
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    const sid = site.info.session_id;
    st.sdk.noFile.add(sid);
    await site.restart();
    const q2 = st.query("site@laptop");
    expect(q2.options.sessionId).toBe(sid);
    expect(q2.options.resume).toBeUndefined();
    expect(st.journal().filter((l) => l.ev === "launch" && l.callsign === "site@laptop").map((l) => l.start)).toEqual(["spawn", "spawn"]);
    st.sdk.noFile.delete(sid);
    await site.restart();
    expect(st.query("site@laptop").options.resume).toBe(sid);

    const copy = await st.kernel.open({ callsign: "copy@laptop", cwd: st.home, resume: "orig-0001", fork: true });
    st.sdk.noFile.add(copy.rec.session_id);
    await copy.restart();
    expect(st.query("copy@laptop").options).toMatchObject({ resume: "orig-0001", forkSession: true, sessionId: copy.rec.session_id });
  });

  it("restart модуля без ожидания: процесс не поднялся — сессия ведёт свой сбой, Host не падает", async () => {
    let s0: Parameters<NonNullable<Module["session"]>>[0] | null = null;
    const st = await stand({ modules: [module("host-prof", { session: (s) => void (s0 ??= s) })] });
    await st.open("site@laptop");
    st.keeper.failInitNext = 2;
    void s0!.restart();
    const spawned = (n: number) => () => st.keeper.ops.filter((o) => o.id === "site@laptop" && o.op === "spawn").length === n && !!st.keeper.procs.get("site@laptop")?.alive;
    await until(spawned(2));
    st.proc("site@laptop").exit(1, "No conversation found");
    await until(spawned(3));
    st.proc("site@laptop").exit(1, "No conversation found");
    await until(() => st.kernel.sessions.get("site@laptop")!.state === "failed");
    await new Promise((r) => setTimeout(r, 30));
    expect(st.exits).toEqual([]);
  });
});
