// Юнит-тесты частей ядра и договора модуля на стенде.
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FRAME } from "@switchboard/protocol";
import { clientPath, refuse } from "../contract.ts";
import type { Host, Module } from "../contract.ts";
import { frame, frames } from "../src/holders.ts";
import { InputQueue } from "../src/queue.ts";
import { gate } from "../src/registry.ts";
import { loadRelease } from "../src/release.ts";
import { Stores } from "../src/store.ts";
import { CORE, FakeClock, FakeRelay, msg, module, standHost, until } from "../stand/index.ts";
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
    // get отдаёт копию: правка без set не меняет раздел; update пишет сразу
    fresh.machine<{ a: number }>("m").set({ a: 1 });
    fresh.machine<{ a: number }>("m").get()!.a = 5;
    expect(fresh.machine("m").get()).toEqual({ a: 1 });
    fresh.machine<{ a: number }>("m").update((v) => ({ a: v!.a + 1 }));
    expect(JSON.parse(readFileSync(join(dir, "m.json"), "utf8"))).toEqual({ machine: { a: 2 } });
  });
});

describe("протокол держателя", () => {
  it("байты кадра — образец замороженного протокола keeper: тот же образец проверяет keeper", () => {
    expect(frame("a", "key").toString("latin1")).toBe("a\x00\x00\x00\x03key");
    const got: Array<[string, string]> = [];
    const feed = frames((t, d) => got.push([t, d.toString("utf8")]));
    // кадр выхода держателя приходит кусками
    const x = Buffer.from('x\x00\x00\x00\x25{"code":0,"signal":null,"stderr":"e"}', "latin1");
    feed(x.subarray(0, 3));
    feed(x.subarray(3));
    expect(got).toEqual([["x", '{"code":0,"signal":null,"stderr":"e"}']]);
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
  it("обработчик не из provides, имя ядра в fields, calls мимо SDK и метод ядра, два decide, keeper и Worker без relay (имена keeper сверяет гейт монорепо по его module.json)", () => {
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
        e("host-k", {}, { uses: { "keeper.state@keeper": 1 } }),
        e("host-k2", {}, { uses: { "spawn@keeper": 1 } }),
        e("host-p", {}, { uses: { "push.send@push": 1 } }),
      ],
      false,
    );
    expect(errors).toEqual([
      "host-k: keeper.state@keeper — нет relay (SWITCHBOARD_RELAY)",
      "host-k2: spawn@keeper — нет relay (SWITCHBOARD_RELAY)",
      "host-p: push.send@push — нет relay (SWITCHBOARD_RELAY)",
      "host-a: requests.x — нет в provides",
      "host-b: поле state — имя ядра",
      "host-c: calls close — метод держит ядро",
      "host-c: calls nope — такого метода нет в SDK",
      "decide AskUserQuestion: два владельца — host-q1 и host-q2",
    ]);
  });

  it("годный набор: Worker-имя и keeper.state через relay, uses между модулями той же версии", () => {
    const errors = gate(
      CORE,
      [
        e("host-watch", { requests: { "session.watchers": () => [] } }),
        e("host-questions", {}, { uses: { "session.watchers@host-watch": 1, "roster@relay": 1, "keeper.state@keeper": 1, "host.module@host": 1 }, calls: ["enableRemoteControl", "getSessionMessages"] }),
      ],
      true,
    );
    expect(errors).toEqual([]);
  });
});

describe("выпуск", () => {
  it("выпуск монорепо: ядро, SDK 0.3.311 и список модулей", async () => {
    const r = await loadRelease(join(import.meta.dirname, ".."));
    expect(r).toMatchObject({ sdk: "0.3.311", version: "1.0.0" });
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
  it("host.request: своё имя и имя модуля этой машины — в процессе; keeper машины — через relay на .keeper@машина; Worker-модуль — в relay с to; другая машина — по callsign", async () => {
    let host!: Host;
    const watch = module("host-watch", { requests: { "session.watchers": (req, ctx) => ({ from: ctx.from, cs: req.callsign }) } });
    const q = module("host-questions", { start: (h) => void (host = h), requests: { answer: () => "own" } }, {
      uses: { "session.watchers@host-watch": 1, "keeper.state@keeper": 1, "push.send@push": 1, "session.watchers@host-watch2": 1 },
    });
    q.manifest.uses = { "session.watchers@host-watch": 1, "keeper.state@keeper": 1, "push.send@push": 1 };
    const st = await stand({ modules: [watch, q] });
    await st.open("site@laptop");
    const ks = host.request("keeper.state", { v: 1, to: ".keeper@laptop" });
    await until(() => st.relay.frames("keeper.state").length === 1);
    const kf = st.relay.frames("keeper.state")[0];
    expect(kf).toMatchObject({ type: "keeper.state", to: ".keeper@laptop" });
    st.relay.deliver({ type: "reply", id: kf.id, ok: true, result: { keeper: "0.5.0" } });
    expect(await ks).toEqual({ ok: true, result: { keeper: "0.5.0" } });
    const push = host.request("push.send", { v: 1, clients: ["phone~owner@example.com"] });
    await until(() => st.relay.frames("push.send").length === 1);
    const f = st.relay.frames("push.send")[0];
    expect(f).toMatchObject({ type: "push.send", v: 1, to: ".push" });
    // отказ несёт все поля reply владельца без конверта
    st.relay.deliver({ type: "reply", id: f.id, from: "push", to: "@laptop", ok: false, error: "not_owner", owner: "pc", missing: [1, 2] });
    expect(await push).toEqual({ ok: false, error: "not_owner", owner: "pc", missing: [1, 2] });
    const remote = host.request("session.watchers", { v: 1, callsign: "api@pc" });
    await until(() => st.relay.frames("session.watchers").length === 1);
    const g = st.relay.frames("session.watchers")[0];
    expect(g.to).toBeUndefined();
    st.relay.deliver({ type: "reply", id: g.id, ok: true, result: [] });
    expect(await remote).toEqual({ ok: true, result: [] });
  });

  it("745 · query() сессии получает путь к claude, который нашёл Host: SDK не ищет его второй раз", async () => {
    // источник: факт 2 нояб. — открытие сессии на wsl ждало ~21 с: профиль CPU — 20 с в process.report.getReport() поиска claude в SDK
    const st = await standHost();
    await st.open("site@laptop");
    expect(st.query("site@laptop").options.pathToClaudeCodeExecutable).toBe(st.sdk.bin);
    await st.close();
  });

  it("747 · папка клиента — одно правило: «~» и «~/…» от домашней папки, полный путь как есть, иначе null", () => {
    // источник: факт 2 нояб. — подъём точки считал «x» от папки выпуска Host, открытие сессии и файлы машины отказывали
    const home = join(tmpdir(), "u");
    expect(clientPath("~", home)).toBe(home);
    expect(clientPath("~/a/b", home)).toBe(join(home, "a", "b"));
    const abs = join(tmpdir(), "srv", "x");
    expect(clientPath(abs, home)).toBe(abs);
    expect(clientPath("x", home)).toBeNull();
    expect(clientPath("./x", home)).toBeNull();
  });

  it("748 · запрос и кадр модуля без v — версия из его uses или provides; названная — как есть", async () => {
    // источник: чьё: код (так делает ядро веба: v из uses)
    let host!: Host;
    const q = module("host-questions", { start: (h) => void (host = h) }, { uses: { "session.watchers@host-watch": 2, "ledger.add@ledger": 1 } });
    const watch = module("host-watch", {}, { provides: { "session.watchers": 2 } });
    const st = await stand({ modules: [watch, q] });
    void host.request("session.watchers", { callsign: "api@pc" });
    await until(() => st.relay.frames("session.watchers").length === 1);
    expect(st.relay.frames("session.watchers")[0]).toMatchObject({ v: 2, callsign: "api@pc" });
    expect(host.emit({ type: "ledger.add", to: ".ledger", ev: "x", text: "y" })).toEqual({ ok: true });
    expect(st.relay.frames("ledger.add")[0]).toMatchObject({ v: 1, to: ".ledger" });
    // названная — как есть: в запросе и в кадре
    void host.request("session.watchers", { callsign: "api@pc", v: 3 });
    await until(() => st.relay.frames("session.watchers").length === 2);
    expect(st.relay.frames("session.watchers")[1]).toMatchObject({ v: 3 });
    expect(host.emit({ type: "ledger.add", to: ".ledger", ev: "x", text: "y", v: 2 })).toEqual({ ok: true });
    expect(st.relay.frames("ledger.add")[1]).toMatchObject({ v: 2 });
  });

  it("750 · своё имя без v — версия из своих provides; названа чужая версия — contract_mismatch, вызывающий не выключен", async () => {
    // источник: чьё: код (ядро Host: v из provides; отказ версии — словом, модуль работает дальше)
    let host!: Host;
    const watch = module("host-watch", { requests: { "session.watchers": () => "ok" }, start: (h) => void (host = h) }, { provides: { "session.watchers": 2 } });
    const st = await stand({ modules: [watch] });
    expect(await host.request("session.watchers", {})).toEqual({ ok: true, result: "ok" });
    expect(await host.request("session.watchers", { v: 1 })).toEqual({ ok: false, error: "contract_mismatch" });
    expect(await host.request("session.watchers", {})).toEqual({ ok: true, result: "ok" });
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });

  it("749 · host.roster() — последний roster от relay; кадр roster без модуля-получателя — не «владельца нет»", async () => {
    // источник: чьё: код (так у ядра веба: app.roster())
    let host!: Host;
    const q = module("host-questions", { start: (h) => void (host = h) });
    // relay придерживает первый roster: до него у ядра roster нет
    const relayStand = new FakeRelay();
    relayStand.holdRoster = true;
    const st = await stand({ modules: [q], relayStand });
    const r = { type: "roster", machines: [], sessions: [], clients: ["phone~owner@example.com"], workers: [] };
    // до первого roster — null
    expect(host.roster()).toBeNull();
    st.relay.deliver(r);
    await until(() => (host.roster()?.clients ?? []).length === 1);
    expect(host.roster()).toMatchObject({ clients: ["phone~owner@example.com"] });
    // следующий — заменяет прежний
    st.relay.deliver({ ...r, clients: [] });
    await until(() => (host.roster()?.clients ?? [1]).length === 0);
    expect(host.roster()).toMatchObject({ clients: [] });
    expect(st.journal().some((l) => l.ev === "frame" && l.word === "unknown_request")).toBe(false);
  });

  it("744 · host.request: машина-адресат — одно правило hostOf: callsign другой машины важнее machine этой — через relay", async () => {
    // источник: чьё: код (protocol hostOf — порядок рации: to, затем callsign, затем machine)
    let host!: Host;
    const watch = module("host-watch", { requests: { "session.watchers": () => "local" } });
    const q = module("host-questions", { start: (h) => void (host = h) }, { uses: { "session.watchers@host-watch": 1 } });
    const st = await stand({ modules: [watch, q] });
    const r = host.request("session.watchers", { v: 1, machine: "laptop", callsign: "api@pc" });
    await until(() => st.relay.frames("session.watchers").length === 1);
    const g = st.relay.frames("session.watchers")[0];
    expect(g).toMatchObject({ machine: "laptop", callsign: "api@pc" });
    st.relay.deliver({ type: "reply", id: g.id, ok: true, result: ["remote"] });
    expect(await r).toEqual({ ok: true, result: ["remote"] });
  });

  it("refuse(слово) — reply с этим словом и refuse в журнале от модуля, модуль не выключен; отказ из другой копии пакета — по метке", async () => {
    // отказ из другой копии пакета @switchboard/host (метка Symbol.for), как у модуля из папки нового выпуска
    const foreign = Object.assign(new Error("already_answered"), { word: "already_answered", [Symbol.for("switchboard.refusal")]: true });
    let n = 0;
    const q = module("host-questions", {
      requests: {
        answer: () => {
          if (n++ === 0) throw refuse("already_answered", "вопрос toolu_1 закрыт");
          throw foreign;
        },
      },
    });
    const st = await stand({ modules: [q] });
    await st.open("site@laptop");
    for (let i = 0; i < 2; i++) expect(await st.relay.request({ type: "answer", v: 1, callsign: "site@laptop" })).toMatchObject({ ok: false, error: "already_answered" });
    const refused = st.journal().filter((l) => l.ev === "request" && l.word === "already_answered");
    expect(refused).toHaveLength(2);
    expect(refused[0]).toMatchObject({ kind: "refuse", who: "host-questions" });
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
    expect(st.states("site@laptop").every((f) => !f.failed)).toBe(true);
  });

  it("запрос без callsign падает — модуль выключен на машине, failed во всех сессиях", async () => {
    const m = module("host-x", { requests: { "x.do": () => { throw new Error("бах"); } } });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    await st.open("wiki@laptop");
    expect(await st.relay.request({ type: "x.do", v: 1, machine: "laptop" })).toMatchObject({ error: "module_error" });
    for (const cs of ["site@laptop", "wiki@laptop"]) await until(() => (st.states(cs).at(-1)?.failed as Record<string, string>)?.["host-x"]);
    const f = st.journal().filter((l) => l.ev === "module_failed");
    expect(f).toHaveLength(1);
    expect(f[0].why).toContain("модуль выключен на машине");
  });

  it("регрессия: запрос модуля этой машины с callsign ещё не открытой сессии доставляется владельцу", async () => {
    let host!: Host;
    const slots = module("host-slots", { requests: { "session.slot": (req, ctx) => ({ cs: req.callsign, live: !!ctx.host.session(req.callsign as string) }) } });
    const manage = module("host-manage", { start: (h) => void (host = h) }, { uses: { "session.slot@host-slots": 1 } });
    const st = await stand({ modules: [slots, manage] });
    expect(await host.request("session.slot", { v: 1, callsign: "board@laptop", slot: "main" })).toEqual({ ok: true, result: { cs: "board@laptop", live: false } });
    expect(st.journal().some((l) => l.ev === "module_failed" || l.word === "offline")).toBe(false);
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
    const { FakeHolders } = await import("../stand/index.ts");
    const k = new FakeHolders();
    const st = await stand({ holders: k, modules: [remote] });
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
    const st2 = await stand({ holders: k, home: st.home, modules: [remote] });
    expect(seen.sort()).toEqual(["back@laptop resume", "site@laptop attach"]);
    await st2.close();
    await k.close();
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
    const fleet = module("host-fleet", { frames: { message: (f, ctx) => void got.push(`message ${f.text} от ${ctx.from}`) }, on: { frame: (f) => void got.push(`fleet ${f.type}`) } }, { uses: { "roster@relay": 1 } });
    const other = module("host-chat", { on: { frame: (f) => void got.push(`chat ${f.type}`) } });
    const st = await stand({ modules: [fleet, other] });
    got.length = 0; // roster после hello уже пришёл
    st.relay.deliver({ type: "message", to: "site@laptop", from: "poe-bot@pc", text: "привет" });
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [], workers: [] });
    await until(() => got.length === 2);
    expect(got).toEqual(["message привет от poe-bot@pc", "fleet roster"]);
  });

  it("host.emit: своё имя — в relay; чужое без uses — ошибка модуля: выключен, кадр не ушёл", async () => {
    let host!: Host;
    const q = module("host-questions", { start: (h) => void (host = h) }, { provides: { question: 1 } });
    const st = await stand({ modules: [q] });
    expect(host.emit({ type: "question", to: ["phone~owner@example.com"], question: "toolu_1" })).toEqual({ ok: true });
    await until(() => st.relay.frames("question").length === 1);
    expect(() => host.emit({ type: "message", to: "x@pc" })).toThrow("message нет в provides и uses");
    expect(st.relay.frames("message")).toEqual([]);
    expect(st.journal().filter((l) => l.ev === "module_failed")[0]).toMatchObject({ module: "host-questions" });
  });

  // чьё: код — контракт Host.emit «Обрыв — disconnected; очереди нет; больше предела кадра — too_large»; факт Cloudflare: сообщение WebSocket в Durable Object до 32 МиБ
  it("293 · host.emit: связи нет — disconnected; кадр больше 32 МиБ — too_large с байтами, кадр не ушёл, связь жива", async () => {
    let host!: Host;
    const q = module("host-questions", { start: (h) => void (host = h) }, { provides: { question: 1 } });
    const st0 = await stand({ modules: [q], relay: false });
    expect(st0.host("host-questions").emit({ type: "question" })).toEqual({ ok: false, error: "disconnected" });
    const st = await stand({ modules: [q] });
    const r = host.emit({ type: "question", to: ["phone~owner@example.com"], question: "я".repeat(17 * 1024 * 1024) });
    expect(r).toMatchObject({ ok: false, error: "too_large" });
    expect(r.bytes).toBeGreaterThan(MAX_FRAME);
    expect(st.relay.frames("question")).toEqual([]);
    expect(host.emit({ type: "question", to: ["phone~owner@example.com"], question: "toolu_1" })).toEqual({ ok: true });
    await until(() => st.relay.frames("question").length === 1);
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
    expect(pq.options.permissionMode).toBe("bypassPermissions");
    expect(pq.options.spawnClaudeCodeProcess).toBeUndefined();
    // путь к claude — тот, что нашёл Host: SDK его не ищет (поиск SDK на Linux — process.report, ~20 с)
    expect(pq.options.pathToClaudeCodeExecutable).toBe(st.sdk.bin);
    expect(pq.calls.at(-1)).toEqual({ name: "claudeAuthenticate", args: [true] });
    expect(st.kernel.sessions.size).toBe(1);
    p.close();
    expect(pq.closed).toBe(true);
    await host.cli(["auth", "status"], { env: { CLAUDE_CONFIG_DIR: "/acc/y0902" }, input: "код" });
    expect(st.sdk.cliCalls[0]).toMatchObject({ args: ["auth", "status"], env: { CLAUDE_CONFIG_DIR: "/acc/y0902", DISABLE_UPDATES: "1" }, input: "код" });
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
    expect(st2.sdk.queries).toEqual([]);
    expect(st2.journal().find((l) => l.ev === "open")).toMatchObject({ kind: "stop", callsign: "site@laptop", why: "env CLAUDE_SECURESTORAGE_CONFIG_DIR: два владельца — host-slots и host-dup" });
    expect(existsSync(join(st2.home, "store", "core.json"))).toBe(false);
  });

  it("s.stop, s.start({ point }), s.remove: state, keeper kill, resume, разделы стёрты, state null в relay", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const m = module("host-manage", { on: { open: (s) => void opened.push(s.info.start), close: (s) => void closed.push(s.info.callsign) } });
    const other = module("host-other", {});
    const st = await stand({ modules: [m, other] });
    await st.open("site@laptop");
    await st.open("wiki@laptop");
    const s = st.session("host-manage", "site@laptop")!;
    s.store().set({ spec: 1 });
    st.session("host-other", "site@laptop")!.store().set({ x: 1 });
    st.session("host-other", "wiki@laptop")!.store().set({ x: 2 });
    await s.stop();
    expect(s.state).toBe("stopped");
    expect(st.kernel.sessions.get("site@laptop")!.rec.stopped).toBe(true);
    expect(st.holders.procs.has("site@laptop")).toBe(false);
    await s.start({ point: 318 });
    expect(s.info).toMatchObject({ start: "point", point: 318 });
    expect(st.query("site@laptop").options.resume).toBe(s.info.session_id);
    await s.remove();
    expect(st.kernel.sessions.has("site@laptop")).toBe(false);
    expect(st.relay.frames("session.state").at(-1)).toEqual({ type: "session.state", callsign: "site@laptop", state: null });
    expect(JSON.parse(readFileSync(join(st.home, "store", "host-manage.json"), "utf8")).sessions).toEqual({});
    expect(JSON.parse(readFileSync(join(st.home, "store", "host-other.json"), "utf8")).sessions).toEqual({ "wiki@laptop": { x: 2 } });
    expect(opened).toEqual(["spawn", "spawn", "point"]);
    expect(closed).toEqual(["site@laptop", "site@laptop"]);
    expect(JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")).sessions.map((r: { callsign: string }) => r.callsign)).toEqual(["wiki@laptop"]);
    expect(st.journal().filter((l) => l.ev === "remove").map((l) => l.callsign)).toEqual(["site@laptop"]);
    // после remove записи этой сессии в relay не шлются
    const sent = st.relay.frames("session.state").length;
    s.refresh();
    expect(st.relay.frames("session.state")).toHaveLength(sent);
  });

  it("host.open с resume, fork и point: вид старта и session_id по spec", async () => {
    const seen: Array<{ callsign: string; start: string; point?: number }> = [];
    const st = await stand({ modules: [module("host-x", { on: { open: (s) => void seen.push(s.info) } })] });
    const r = await st.kernel.open({ callsign: "back@laptop", cwd: st.home, resume: "sid-0" });
    expect(r.rec.session_id).toBe("sid-0");
    expect(st.query("back@laptop").options.resume).toBe("sid-0");
    const s = await st.kernel.open({ callsign: "copy@laptop", cwd: st.home, resume: "orig-id", fork: true });
    const o = st.query("copy@laptop").options;
    expect(o).toMatchObject({ resume: "orig-id", forkSession: true, sessionId: s.rec.session_id });
    expect(s.rec.session_id).not.toBe("orig-id");
    await st.kernel.open({ callsign: "pt@laptop", cwd: st.home, resume: "sid-pt", point: 3 });
    expect(seen.map((i) => [i.callsign, i.start, i.point])).toEqual([
      ["back@laptop", "resume", undefined],
      ["copy@laptop", "resume", undefined],
      ["pt@laptop", "point", 3],
    ]);
  });

  it("746 · elicit: владелец решает форму; владельца нет — decline; владелец бросил — decline, выключен в сессии, следующая форма — decline без него", async () => {
    const m = module("host-questions", { elicit: (_s, req) => ({ action: "accept", content: { project: String((req as { message: string }).message) } }) });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    expect(await st.proc("site@laptop").elicit({ serverName: "jira", message: "SB", mode: "form" })).toEqual({ action: "accept", content: { project: "SB" } });
    const st2 = await stand({ modules: [] });
    await st2.open("site@laptop");
    expect(await st2.proc("site@laptop").elicit({ serverName: "jira", message: "x" })).toEqual({ action: "decline" });
    expect(st2.journal().find((l) => l.ev === "elicit")).toMatchObject({ callsign: "site@laptop" });
    let calls = 0;
    const bad = module("host-questions", { elicit: () => { calls++; throw new Error("форма упала"); } });
    const st3 = await stand({ modules: [bad] });
    await st3.open("site@laptop");
    expect(await st3.proc("site@laptop").elicit({ serverName: "jira", message: "x" })).toEqual({ action: "decline" });
    await until(() => st3.states("site@laptop").at(-1)?.failed?.["host-questions"]);
    expect(st3.journal().filter((l) => l.ev === "module_failed")).toHaveLength(1);
    // 746 · владелец выключен в сессии — следующая форма decline без вызова владельца
    expect(await st3.proc("site@laptop").elicit({ serverName: "jira", message: "y" })).toEqual({ action: "decline" });
    expect(calls).toBe(1);
  });

  it("start() модуля бросил на старте Host: выключен на машине, failed в roster, Host работает", async () => {
    const bad = module("host-bad", { start: () => { throw new Error("нет конфига"); }, requests: { "bad.x": () => 1 } });
    const good = module("host-good", { requests: { "good.x": () => 2 } });
    const st = await stand({ modules: [bad, good] });
    expect(st.startError).toBeNull();
    expect(st.journal().find((l) => l.ev === "module_failed")).toMatchObject({ kind: "stop", word: "module_error", module: "host-bad" });
    expect(st.journal().find((l) => l.ev === "module_failed")!.why).toContain("модуль выключен на машине");
    expect(st.journal().some((l) => l.ev === "ready")).toBe(true);
    await st.open("site@laptop");
    expect(st.states("site@laptop").at(-1)!.failed).toEqual({ "host-bad": "нет конфига · start" });
    expect(await st.relay.request({ type: "bad.x", v: 1 })).toMatchObject({ error: "module_error" });
    expect(await st.relay.request({ type: "good.x", v: 1 })).toMatchObject({ ok: true, result: 2 });
  });

  it("журнал: строка JSON на запись, t по часам ядра, part host, who — модуль; kind по умолчанию note", async () => {
    let host!: Host;
    const m = module("host-journal", { start: (h) => void (host = h) });
    const st = await stand({ modules: [m] });
    host.log({ ev: "sdk.result", callsign: "site@laptop" });
    host.log({ kind: "refuse", ev: "z" });
    const l = st.journal().find((x) => x.ev === "sdk.result")!;
    expect(l).toEqual({ t: "2026-10-30T14:00:00.000Z", part: "host", machine: "laptop", who: "host-journal", kind: "note", ev: "sdk.result", callsign: "site@laptop" });
    expect(st.journal().find((x) => x.ev === "z")).toMatchObject({ kind: "refuse", who: "host-journal" });
    expect(existsSync(join(st.home, "journal", "host-2026-10-30.jsonl"))).toBe(true);
  });

  it("процесс, которого нет в списке сессий, — kill и строка в журнале", async () => {
    const { FakeHolders } = await import("../stand/index.ts");
    const k = new FakeHolders();
    const orphan = await k.addProcess("ghost@laptop");
    const st = await stand({ holders: k, modules: [] });
    expect(orphan.alive).toBe(false);
    expect(st.journal().some((l) => l.ev === "orphan_kill" && l.callsign === "ghost@laptop")).toBe(true);
    await st.close();
    await k.close();
  });

  it("поле roster собирается после каждого сообщения SDK; не изменилось — session.state не шлётся; on.event — по порядку списка модулей", async () => {
    let n = 0;
    const order: string[] = [];
    const first = module("host-first", { on: { event: (_s, x) => void order.push(`first ${x.type}`) } });
    const m = module("host-count", { fields: { count: () => n }, on: { event: (_s, x) => void (order.push(`count ${x.type}`), x.type === "assistant" && n++) } });
    const st = await stand({ modules: [first, m] });
    await st.open("site@laptop");
    const before = st.states("site@laptop").length;
    const p = st.proc("site@laptop");
    p.send(msg.assistant("a"));
    p.send(msg.init("sid"));
    p.send(msg.assistant("b"));
    await until(() => st.states("site@laptop").at(-1)?.count === 2);
    expect(st.states("site@laptop").length).toBe(before + 2);
    expect(order).toEqual(["first assistant", "count assistant", "first system", "count system", "first assistant", "count assistant"]);
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
    st.holders.failInitNext = 2;
    void s0!.restart();
    const spawned = (n: number) => () => st.holders.ops.filter((o) => o.id === "site@laptop" && o.op === "spawn").length === n && !!st.holders.procs.get("site@laptop")?.alive;
    await until(spawned(2));
    st.proc("site@laptop").exit(1, "No conversation found");
    await until(spawned(3));
    st.proc("site@laptop").exit(1, "No conversation found");
    await until(() => st.kernel.sessions.get("site@laptop")!.state === "failed");
    await new Promise((r) => setTimeout(r, 30));
    expect(st.exits).toEqual([]);
    expect(st.journal().filter((l) => l.ev === "session_failed")).toHaveLength(1);
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });
});
