// Эталоны ядра Host на стенде: поддельные SDK, relay, держатели и часы. Номер эталона — номер теста.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { check } from "@switchboard/manifest-gate";
import { FakeHolders, msg, module, standHost, turn, until } from "../stand/index.ts";
import type { Stand } from "../stand/index.ts";
import type { Host, Module } from "../contract.ts";

const stands: Stand[] = [];
const keepers: FakeHolders[] = [];
async function stand(o: Parameters<typeof standHost>[0] = {}): Promise<Stand> {
  const st = await standHost(o);
  stands.push(st);
  return st;
}
async function keeper(): Promise<FakeHolders> {
  const k = new FakeHolders();
  keepers.push(k);
  return k;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const st of stands.splice(0)) await st.close();
  for (const k of keepers.splice(0)) await k.close();
});

/** Модуль расхода из дизайна: поле cost и запрос session.cost. */
function cost(version = "1.0.0", extra: Partial<Module> = {}, provides: Record<string, number> = {}) {
  const mod: Module = {
    fields: { cost: (s) => s.store<{ usd: number; turns: number }>().get() ?? { usd: 0, turns: 0 } },
    on: {
      event(s, m) {
        if (m.type !== "result") return;
        s.store<{ usd: number; turns: number }>().update((c = { usd: 0, turns: 0 }) => ({ usd: c.usd + (m as { total_cost_usd: number }).total_cost_usd, turns: c.turns + 1 }));
      },
    },
    requests: { "session.cost": (req, { host }) => host.session(req.callsign as string)!.store().get() },
    ...extra,
  };
  return module("host-cost", mod, { version, provides });
}

const lines = (st: Stand, ev?: string) => st.journal().filter((l) => !ev || l.ev === ev);

describe("эталоны ядра Host", () => {
  it("17 · Host запущен заново посреди команды: attach, накопленный вывод дочитан, тот же ход дошёл до result", async () => {
    const k = await keeper();
    const p = await k.addProcess("site@laptop");
    // вывод, накопленный без Host: команда закончилась, ход дошёл до конца
    p.send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "долгая команда закончилась" }] }, parent_tool_use_id: null });
    p.send(msg.result());
    p.send(msg.state("idle"));
    const got: string[] = [];
    const st = await stand({
      holders: k,
      sessions: [{ callsign: "site@laptop", session_id: "8380f18f", state: "busy" }],
      modules: [module("host-watch", { on: { event: (_s, m) => void got.push(m.type) } })],
    });
    await until(() => got.includes("result"));
    expect(k.ops.filter((o) => o.id === "site@laptop").map((o) => o.op)).toEqual(["attach"]);
    expect(p.initializes).toBe(1); // новый query() шлёт initialize тому же процессу
    expect(got).toEqual(["user", "result", "system"]);
    const s = st.session("host-watch", "site@laptop")!;
    expect(s.info.start).toBe("attach");
    expect(s.info.session_id).toBe("8380f18f");
    await until(() => s.state === "idle");
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
  });

  it("18 · два владельца session.cost — Host не стартует, сессии не тронуты", async () => {
    const k = await keeper();
    const p = await k.addProcess("site@laptop");
    const dup = module("host-dup", { requests: { "session.cost": () => 0 } });
    const st = await stand({ holders: k, sessions: [{ callsign: "site@laptop" }], modules: [cost(), dup] });
    expect(st.startError?.reasons).toContain("session.cost: два владельца — host-cost и host-dup");
    expect(lines(st, "gate").map((l) => l.why)).toContain("session.cost: два владельца — host-cost и host-dup");
    expect(k.ops).toEqual([]); // к keeper Host не подключался
    expect(p.alive).toBe(true);
    expect(st.relay.conns).toHaveLength(0);
  });

  it("19 · buggy бросил в on.event: выключен в site, остальные получают всё, ход дошёл до result; в wiki работает", async () => {
    const seen: Record<string, string[]> = { "site@laptop": [], "wiki@laptop": [] };
    const buggy = module("host-buggy", {
      on: {
        event(s, m) {
          if (s.info.callsign === "site@laptop" && m.type === "assistant") throw new TypeError("Cannot read properties of undefined");
        },
      },
      requests: { "buggy.ping": () => "pong" },
    });
    const printer = module("host-printer", { on: { event: (s, m) => void seen[s.info.callsign].push(m.type) } });
    const st = await stand({ modules: [buggy, printer] });
    await st.open("site@laptop");
    await st.open("wiki@laptop");
    turn(st.proc("site@laptop"));
    turn(st.proc("site@laptop"));
    await until(() => seen["site@laptop"].filter((t) => t === "result").length === 2);
    expect(seen["site@laptop"]).toEqual(["system", "assistant", "result", "system", "system", "assistant", "result", "system"]);
    const last = st.states("site@laptop").at(-1)!;
    expect(last.failed).toEqual({ "host-buggy": "Cannot read properties of undefined · on.event" });
    expect(lines(st, "module_failed")).toHaveLength(1);
    expect(await st.relay.request({ type: "buggy.ping", v: 1, callsign: "site@laptop" })).toMatchObject({ ok: false, error: "module_error" });
    expect(await st.relay.request({ type: "buggy.ping", v: 1, callsign: "wiki@laptop" })).toMatchObject({ ok: true, result: "pong" });
    turn(st.proc("wiki@laptop"));
    await until(() => seen["wiki@laptop"].includes("result"));
    expect(st.states("wiki@laptop").every((f) => !f.failed)).toBe(true);
  });

  it("60 · состояние только из session_state_changed: busy, waiting, busy, idle; result сам не меняет", async () => {
    const st = await stand({ modules: [] });
    await st.open("site@laptop");
    const before = st.states("site@laptop").length;
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    p.send(msg.state("requires_action"));
    p.send(msg.state("running"));
    p.send(msg.result());
    p.send(msg.state("idle"));
    await until(() => st.states("site@laptop").length === before + 4);
    await new Promise((r) => setTimeout(r, 30));
    expect(st.states("site@laptop").slice(before).map((f) => f.state)).toEqual(["busy", "waiting", "busy", "idle"]);
  });

  it("61 · AskUserQuestion: questions выключен — deny module_error; модуля нет — deny unknown_request; за человека не выбрано", async () => {
    const questions = module("host-questions", {
      decide: { AskUserQuestion: () => new Promise(() => {}) },
      on: {
        event(_s, m) {
          if (m.type === "assistant") throw new Error("сломался");
        },
      },
    });
    const st = await stand({ modules: [questions] });
    await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.assistant("спрошу"));
    await until(() => lines(st, "module_failed").length === 1);
    const r1 = await p.ask("AskUserQuestion", { questions: [{ question: "Цвет?", options: [{ label: "Синий" }, { label: "Красный" }] }] });
    expect(r1).toEqual({ behavior: "deny", message: "module_error" });

    const st2 = await stand({ modules: [] });
    await st2.open("site@laptop");
    const r2 = await st2.proc("site@laptop").ask("AskUserQuestion", { questions: [] });
    expect(r2).toEqual({ behavior: "deny", message: "unknown_request" });
    expect(lines(st2, "decide")[0]).toMatchObject({ kind: "refuse", word: "unknown_request" });
    // прочие инструменты — по режиму «разрешено всё», строкой в журнале
    expect(await st2.proc("site@laptop").ask("Bash", { command: "ls" })).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  });

  it("62 · хук guard бросил: отвечает {}, хук audit вызван, guard выключен в site, ход идёт", async () => {
    const audit: string[] = [];
    const guard = module("host-guard", {
      session: () => ({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [async () => { throw new Error("guard упал"); }] }] } }),
    });
    const auditM = module("host-audit", {
      session: () => ({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [async (inp) => { audit.push(String((inp as { tool_input: { command: string } }).tool_input.command)); return { continue: true }; }] }] } }),
    });
    const st = await stand({ modules: [guard, auditM] });
    await st.open("site@laptop");
    const p = st.proc("site@laptop");
    const out = await p.hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf ./build" } }, "toolu_1");
    expect(out).toEqual([{}, { continue: true }]);
    expect(audit).toEqual(["rm -rf ./build"]);
    await until(() => st.states("site@laptop").at(-1)?.failed);
    expect(st.states("site@laptop").at(-1)!.failed).toMatchObject({ "host-guard": "guard упал · hooks.PreToolUse" });
    turn(p);
    await until(() => st.session("host-audit", "site@laptop")!.state === "idle" && st.states("site@laptop").some((f) => f.state === "busy"));
  });

  it("63 · exited посреди хода: starting → resume через spawn → idle; код и stderr в журнале; wiki не тронута", async () => {
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    await st.open("wiki@laptop");
    const sid = site.info.session_id;
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => site.state === "busy");
    p.exit(1, "Error: boom");
    await until(() => st.sdk.of("site@laptop").length === 2 && site.state === "idle");
    expect(st.states("site@laptop").map((f) => f.state)).toContain("starting");
    const q2 = st.query("site@laptop");
    expect(q2.options.resume).toBe(sid);
    expect(st.holders.ops.filter((o) => o.id === "site@laptop").map((o) => o.op)).toEqual(["spawn", "attach", "spawn", "attach"]);
    expect(lines(st, "session_exited")[0].why).toContain("код 1: Error: boom");
    expect(st.sdk.of("wiki@laptop")).toHaveLength(1);
    expect(site.info.start).toBe("resume");
  });

  it("64 · второй сбой до готовности: failed, третьего запуска нет, обе причины в журнале; session.start поднимает", async () => {
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    st.holders.failInitNext = 1;
    st.proc("site@laptop").exit(1, "первый");
    await until(() => st.sdk.of("site@laptop").length === 2 && st.holders.procs.get("site@laptop")?.initializes === 1);
    st.proc("site@laptop").exit(1, "второй");
    await until(() => site.state === "failed");
    await new Promise((r) => setTimeout(r, 30));
    expect(st.sdk.of("site@laptop")).toHaveLength(2);
    const why = lines(st, "session_failed")[0].why;
    expect(why).toContain("первый");
    expect(why).toContain("второй");
    expect(st.states("site@laptop").at(-1)!.state).toBe("failed");
    await site.start();
    expect(site.state).toBe("idle");
    expect(st.sdk.of("site@laptop")).toHaveLength(3);
  });

  it("65 · cost записал расход; Host убит; новый Host после start() отдаёт то же поле и ответ; файл — целый JSON", async () => {
    const k = await keeper();
    const st = await stand({ holders: k, modules: [cost()] });
    await st.open("site@laptop");
    turn(st.proc("site@laptop"));
    await until(() => (st.states("site@laptop").at(-1)?.cost as { turns: number })?.turns === 1);
    st.crash();
    const st2 = await stand({ holders: k, home: st.home, modules: [cost()] });
    expect((st2.relay.hellos[0].sessions as Array<Record<string, unknown>>)[0]).toMatchObject({ callsign: "site@laptop", cost: { usd: 0.012, turns: 1 } });
    expect(await st2.relay.request({ type: "session.cost", v: 1, callsign: "site@laptop" })).toMatchObject({ ok: true, result: { usd: 0.012, turns: 1 } });
    const file = JSON.parse(readFileSync(join(st.home, "store", "host-cost.json"), "utf8"));
    expect(file.sessions["site@laptop"]).toEqual({ usd: 0.012, turns: 1 });
  });

  it("66 · budget без uses зовёт session.history, в wiki — s.sdk(setModel) без calls: не вызваны, budget выключен в обеих", async () => {
    let host!: Host;
    const history = vi.fn(() => []);
    const budget = module("host-budget", {
      start: (h) => void (host = h),
      on: {
        event(s, m) {
          if (m.type !== "assistant") return;
          if (s.info.callsign === "site@laptop") void host.request("session.history", { v: 1, callsign: "site@laptop" });
          else void s.sdk("setModel", "opus");
        },
      },
    });
    const chat = module("host-chat", { requests: { "session.history": history } });
    const st = await stand({ modules: [budget, chat] });
    await st.open("site@laptop");
    await st.open("wiki@laptop");
    st.proc("site@laptop").send(msg.assistant("a"));
    st.proc("wiki@laptop").send(msg.assistant("b"));
    await until(() => lines(st, "module_failed").length === 2);
    expect(history).not.toHaveBeenCalled();
    expect(st.query("wiki@laptop").calls.some((c) => c.name === "setModel")).toBe(false);
    const whys = lines(st, "module_failed").map((l) => `${l.callsign}: ${l.why}`).join("\n");
    expect(whys).toContain("site@laptop: host-budget: договор — Error: session.history нет в uses");
    expect(whys).toContain("wiki@laptop: host-budget: договор — Error: setModel нет в calls");
  });

  it("67 · ввод Host закрыт (keeper меняет версию): session.prompt — shutting_down; stop() модулей обратным порядком; выход 0; процессы claude живут у держателей; новый Host подключается к ним", async () => {
    const k = await keeper();
    const order: string[] = [];
    const journalM = module("host-journal", { stop: () => void order.push("stop journal") });
    const prompt = vi.fn();
    const chat = module("host-chat", { requests: { "session.prompt": prompt }, stop: () => void order.push("stop chat") });
    const st = await stand({ holders: k, modules: [journalM, chat] });
    await st.open("site@laptop");
    await st.open("wiki@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => st.session("host-chat", "site@laptop")!.state === "busy");
    const down = st.kernel.shutdown("ввод закрыт");
    const r = await st.relay.request({ type: "session.prompt", v: 1, callsign: "wiki@laptop", text: "x" });
    expect(r).toMatchObject({ ok: false, error: "shutting_down" });
    await down;
    expect(prompt).not.toHaveBeenCalled();
    expect(p.interrupts).toBe(0);
    expect(order).toEqual(["stop chat", "stop journal"]);
    expect(st.relay.clientCloses.at(-1)).toEqual({ code: 1000, reason: "shutting_down" });
    expect(st.exits).toEqual([0]);
    expect([...k.procs.values()].every((x) => x.alive)).toBe(true);
    expect(k.ops.filter((o) => o.op === "kill" || o.op === "close_input")).toEqual([]);
    const st2 = await stand({ holders: k, home: st.home, modules: [] });
    for (const cs of ["site@laptop", "wiki@laptop"]) expect(st2.kernel.sessions.get(cs)!.startKind).toBe("attach");
    expect(st2.kernel.sessions.get("site@laptop")!.state).toBe("busy");
  });

  it("68 · обрыв relay: ждущий запрос сразу disconnected; паузы 1, 2, 4 с; новый hello — те же сессии и contract; ходы не прерывались", async () => {
    let host!: Host;
    const fleet = module("host-fleet", { start: (h) => void (host = h), frames: { message: () => {} } });
    const st = await stand({ modules: [fleet, cost()] });
    await st.open("site@laptop");
    const pid = st.proc("site@laptop").pid;
    const hello1 = st.relay.hellos[0];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const waiting = host.request("message", { v: 1, to: "poe-bot@pc", text: "привет" });
    await until(() => st.relay.frames("message").length === 1);
    st.relay.refuse = ["gate_unavailable", "gate_unavailable"];
    st.relay.drop(1006);
    expect(await waiting).toEqual({ ok: false, error: "disconnected" });
    const conns = () => st.relay.conns.length;
    for (const pause of [1000, 2000, 4000]) {
      const before = conns();
      vi.advanceTimersByTime(pause - 1);
      await new Promise((r) => setImmediate(r));
      expect(conns()).toBe(before);
      vi.advanceTimersByTime(1);
      await until(() => conns() === before + 1);
      await until(() => st.relay.hellos.length === conns());
    }
    const hello = st.relay.hellos.at(-1)!;
    expect(hello.contract).toEqual(hello1.contract);
    expect((hello.sessions as object[]).map((s) => (s as { callsign: string }).callsign)).toEqual(["site@laptop"]);
    expect(st.proc("site@laptop").pid).toBe(pid);
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
  });

  it("69 · Host с другой версией SDK: обе attach; wiki сразу close и resume, site — после result; обе на новой версии", async () => {
    const k = await keeper();
    const site = await k.addProcess("site@laptop");
    const wiki = await k.addProcess("wiki@laptop");
    site.busy = true;
    const st = await stand({
      holders: k,
      sdkVersion: "0.3.312",
      sessions: [
        { callsign: "site@laptop", sdk: "0.3.311", state: "busy" },
        { callsign: "wiki@laptop", sdk: "0.3.311", state: "idle" },
      ],
    });
    await until(() => st.sdk.of("wiki@laptop").length === 2 && st.kernel.sessions.get("wiki@laptop")!.state === "idle");
    expect(wiki.alive).toBe(false);
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(site.alive).toBe(true);
    site.send(msg.result());
    site.send(msg.state("idle"));
    await until(() => st.sdk.of("site@laptop").length === 2 && st.kernel.sessions.get("site@laptop")!.state === "idle");
    for (const cs of ["site@laptop", "wiki@laptop"]) {
      expect(k.ops.filter((o) => o.id === cs).map((o) => o.op)).toEqual(["attach", "close_input", "spawn", "attach"]);
      expect(st.kernel.sessions.get(cs)!.rec.sdk).toBe("0.3.312");
      expect(st.query(cs).options.resume).toBe(`sid-${cs.split("@")[0]}`);
    }
  });

  it("150 · гейт монорепо: два владельца, uses без имени у владельца, импорт мимо uses — сборка падает", () => {
    const m = (name: string, provides: Record<string, number>, uses: Record<string, number> = {}, imports: string[] = []) => ({
      name, type: "sdk", version: "1.0.0", provides, uses, config: {}, pkg: `@switchboard/${name}`, imports,
    });
    const base = m("host-cost", { "session.cost": 1, cost: 1 });
    expect(check([base, m("host-dup", { "session.cost": 1 })])).toContain("имя session.cost: два владельца — host-cost и host-dup");
    expect(check([base, m("host-stats", { stats: 1 }, { "session.tokens@host-cost": 1 })])).toContain("модуль host-stats: uses session.tokens@host-cost — host-cost не отдаёт session.tokens");
    expect(check([base, m("host-peek", { peek: 1 }, {}, ["@switchboard/host-cost/src/store.ts"])]).join()).toContain("модуль host-peek: импорт @switchboard/host-cost/src/store.ts");
  });

  it("152 · hello закрыт gate_unavailable дважды: паузы 1 с и 2 с, третий принят, строки stop нет; bad_key — без переподключений, stop в журнале", async () => {
    const st = await stand({ modules: [cost()], start: false });
    st.relay.refuse = ["gate_unavailable", "gate_unavailable"];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const started = st.start();
    await until(() => st.relay.hellos.length === 1);
    vi.advanceTimersByTime(1000);
    await until(() => st.relay.hellos.length === 2);
    vi.advanceTimersByTime(1999);
    await new Promise((r) => setImmediate(r));
    expect(st.relay.hellos).toHaveLength(2);
    vi.advanceTimersByTime(1);
    await until(() => st.relay.hellos.length === 3);
    await started;
    expect(lines(st).filter((l) => l.kind === "stop")).toEqual([]);
    expect(st.relay.hellos[2].contract).toEqual(st.relay.hellos[0].contract);

    const st2 = await stand({ modules: [cost()], start: false });
    st2.relay.refuse = ["bad_key"];
    await st2.start();
    await until(() => lines(st2, "relay_stopped").length === 1);
    vi.advanceTimersByTime(60_000);
    await new Promise((r) => setImmediate(r));
    expect(st2.relay.conns).toHaveLength(1);
    expect(lines(st2, "relay_stopped")[0]).toMatchObject({ kind: "stop", word: "bad_key" });
  });
});
