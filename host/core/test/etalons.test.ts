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
    const started = vi.fn();
    const dup = module("host-dup", { requests: { "session.cost": () => 0 }, start: started });
    const st = await stand({ holders: k, sessions: [{ callsign: "site@laptop" }], modules: [cost(), dup] });
    expect(st.startError?.reasons).toContain("session.cost: два владельца — host-cost и host-dup");
    expect(lines(st, "gate").find((l) => l.why === "session.cost: два владельца — host-cost и host-dup")).toMatchObject({ kind: "stop", word: "check_failed" });
    expect(started).not.toHaveBeenCalled();
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
    expect(lines(st, "decide")[0]).toMatchObject({ kind: "refuse", word: "module_error", module: "host-questions" });

    // решение владельца бросило: deny module_error, владелец выключен в сессии один раз
    const thrower = module("host-questions", { decide: { AskUserQuestion: () => { throw new Error("решение упало"); } } });
    const st3 = await stand({ modules: [thrower] });
    await st3.open("site@laptop");
    for (let i = 0; i < 2; i++) expect(await st3.proc("site@laptop").ask("AskUserQuestion", { questions: [] })).toEqual({ behavior: "deny", message: "module_error" });
    expect(lines(st3, "module_failed")).toHaveLength(1);
    expect(lines(st3, "decide").filter((l) => l.word === "module_error")).toHaveLength(2);
    await until(() => st3.states("site@laptop").at(-1)?.failed?.["host-questions"]);

    const st2 = await stand({ modules: [] });
    await st2.open("site@laptop");
    const r2 = await st2.proc("site@laptop").ask("AskUserQuestion", { questions: [] });
    expect(r2).toEqual({ behavior: "deny", message: "unknown_request" });
    expect(lines(st2, "decide")[0]).toMatchObject({ kind: "refuse", word: "unknown_request" });
    // прочие инструменты тоже: «разрешено всё» решает один владелец — questions; его нет — отказ со строкой журнала
    expect(await st2.proc("site@laptop").ask("Bash", { command: "ls" })).toEqual({ behavior: "deny", message: "unknown_request" });
    expect(lines(st2, "decide")[1]).toMatchObject({ kind: "refuse", word: "unknown_request", tool: "Bash", callsign: "site@laptop" });
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

  it("5525 · выход с os_stop: ОС останавливается — resume нет, сессия stopped, причина в журнале; в записи не остановлена", async () => {
    // источник: слепое расширение плана keeper-holder 3 нояб.; чьё: код — keeper.go exitedPart: «такой выход — не падение, перезапуска нет»
    const closed: string[] = [];
    const st = await stand({ modules: [module("host-watch", { on: { close: (s) => void closed.push(s.info.callsign) } })] });
    const site = await st.open("site@laptop");
    st.proc("site@laptop").exit(0, "", null, true);
    await until(() => site.state === "stopped");
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(lines(st, "session_exited")).toHaveLength(0);
    expect(lines(st, "session_os_stop")[0].why).toContain("остановка ОС");
    expect(closed).toEqual(["site@laptop"]);
    // в записи не остановлена: новый Host поднимает её resume (эталон 3174)
    expect(st.kernel.sessions.get("site@laptop")!.rec.stopped).toBeFalsy();
  });

  it("5526 · после выхода с os_stop session.start поднимает сессию resume тем же разговором: Host пережил сигнал — сессия не потеряна", async () => {
    // источник: устав «Чистый перезапуск», чьё: код — session.ts start; сигнал ОС без остановки Host (kill -TERM держателю)
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    const sid = site.info.session_id;
    st.proc("site@laptop").exit(0, "", null, true);
    await until(() => site.state === "stopped");
    await st.kernel.sessions.get("site@laptop")!.start();
    await until(() => site.state === "idle");
    expect(st.query("site@laptop").options.resume).toBe(sid);
  });

  it("5527 · процесс вышел посреди хода, пока stop ждёт итог хода: stop доходит до конца, сессия stopped", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; слепое расширение плана: interruptTurn ждал result без предела
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => site.state === "busy");
    p.noInterrupt = true;
    const stopping = site.stop();
    await until(() => p.interrupts === 1);
    p.exit(0, "", null, true);
    await stopping;
    expect(site.state).toBe("stopped");
  });

  it("5528 · сессия встала по сигналу ОС, Host остановился — новый Host поднимает её resume тем же разговором, без session.start", async () => {
    // источник: устав «чистый перезапуск начинает с хранилища»; чьё: код — session.ts onExited «новый Host поднимет её сам»
    const k = await keeper();
    const st = await stand({ holders: k, modules: [] });
    const site = await st.open("site@laptop");
    const sid = site.info.session_id;
    st.proc("site@laptop").exit(0, "", null, true);
    await until(() => site.state === "stopped");
    await st.kernel.shutdown("ввод закрыт");
    const st2 = await stand({ holders: k, home: st.home, modules: [] });
    const back = st2.kernel.sessions.get("site@laptop")!;
    await until(() => back.state === "idle");
    expect(st2.query("site@laptop").options.resume).toBe(sid);
    // журнал папки один: строка прежнего Host и новая
    expect(lines(st2, "ready")).toHaveLength(2);
  });

  it("5529 · ход посреди сигнала отдаёт свой вывод: result дошёл до модуля, сессия stopped, resume нет", async () => {
    // источник: устав «доводит или отдаёт текущее»; чьё: код — hold.go: выход отдаётся после всего вывода
    const seen: string[] = [];
    const st = await stand({ modules: [module("host-watch", { on: { event: (_s, m) => void seen.push(m.type) } })] });
    const site = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => site.state === "busy");
    p.send({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "s" });
    p.exit(0, "", null, true);
    await until(() => site.state === "stopped" && seen.includes("result"));
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(lines(st, "session_exited")).toHaveLength(0);
  });

  it("5530 · процесс убит сигналом вместе с держателем: тоже остановка ОС — stopped, сигнал в причине, session_exited и session_failed нет", async () => {
    // чьё: код — hold.go ставит os_stop при любом коде, session.ts смотрит только на него
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    st.proc("site@laptop").exit(null, "", "SIGTERM", true);
    await until(() => site.state === "stopped");
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(lines(st, "session_os_stop")[0].why).toContain("сигнал SIGTERM");
    expect(lines(st, "session_exited")).toHaveLength(0);
    expect(lines(st, "session_failed")).toHaveLength(0);
  });

  it("5545 · сигнал без Host: новый Host забирает выход при подключении — сессия stopped, нового держателя нет, Host доходит до ready", async () => {
    // чьё: код — hold.go отдаёт накопленный выход новому хозяину; session.ts onExited; kernel.ts ждёт settled сессий
    const k = await keeper();
    const p = await k.addProcess("a@laptop");
    p.exit(0, "", null, true);
    const st = await stand({ holders: k, sessions: [{ callsign: "a@laptop" }], modules: [] });
    const a = st.kernel.sessions.get("a@laptop")!;
    await until(() => a.state === "stopped");
    expect(k.spawns).toHaveLength(0);
    expect(lines(st, "session_os_stop")).toHaveLength(1);
    expect(lines(st, "session_exited")).toHaveLength(0);
    expect(lines(st, "session_failed")).toHaveLength(0);
    expect(a.rec.stopped).toBeFalsy();
    expect(lines(st, "ready")).toHaveLength(1);
  });

  it("5546 · выход с os_stop во время штатной остановки Host: запуска нет, session_exited нет, выход 0; новый Host поднимает сессию resume", async () => {
    // источник: устав «каждая часть останавливается штатно»; чьё: код — session.ts «наш close — ожидаемо»
    let release = () => {};
    const wait = new Promise<void>((r) => (release = r));
    let stopping = false;
    const slow = module("host-slow", { stop: async () => { stopping = true; await wait; } });
    const k = await keeper();
    const st = await stand({ holders: k, modules: [slow] });
    const site = await st.open("site@laptop");
    const sid = site.info.session_id;
    const down = st.kernel.shutdown("ввод закрыт");
    await until(() => stopping);
    st.proc("site@laptop").exit(0, "", null, true);
    await until(() => !k.procs.has("site@laptop"));
    release();
    await down;
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(lines(st, "session_exited")).toHaveLength(0);
    expect(lines(st, "session_failed")).toHaveLength(0);
    expect(lines(st, "exit")).toHaveLength(1);
    expect(st.exits).toEqual([0]);
    const st2 = await stand({ holders: k, home: st.home, modules: [] });
    const back = st2.kernel.sessions.get("site@laptop")!;
    await until(() => back.state === "idle");
    expect(st2.query("site@laptop").options.resume).toBe(sid);
  });

  it("63 · exited посреди хода: starting → resume через spawn → idle; код и stderr в журнале; on.close модулей; wiki не тронута", async () => {
    const closed: string[] = [];
    const st = await stand({ modules: [module("host-watch", { on: { close: (s) => void closed.push(s.info.callsign) } })] });
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
    expect(closed).toEqual(["site@laptop"]);
    expect(st.sdk.of("wiki@laptop")).toHaveLength(1);
    expect(site.info.start).toBe("resume");
  });

  it("64 · второй сбой до готовности: failed, третьего запуска нет, обе причины в журнале; session.start поднимает, счётчик сбоев сброшен", async () => {
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
    // после start сбой — снова первый: resume, а не failed
    st.proc("site@laptop").exit(1, "третий");
    await until(() => st.sdk.of("site@laptop").length === 4 && site.state === "idle");
    expect(lines(st, "session_failed")).toHaveLength(1);
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
    expect(lines(st, "relay_stopped")).toEqual([]);
    expect(lines(st).filter((l) => l.ev === "shutdown" || l.ev === "exit").map((l) => l.ev)).toEqual(["shutdown", "exit"]);
    expect(st.exits).toEqual([0]);
    expect([...k.procs.values()].every((x) => x.alive)).toBe(true);
    expect(k.ops.filter((o) => o.op === "kill" || o.op === "close_input")).toEqual([]);
    const st2 = await stand({ holders: k, home: st.home, modules: [] });
    for (const cs of ["site@laptop", "wiki@laptop"]) expect(st2.kernel.sessions.get(cs)!.startKind).toBe("attach");
    expect(st2.kernel.sessions.get("site@laptop")!.state).toBe("busy");
  });

  it("3149 · start() модуля не возвращается — за 12 с модуль выключен с причиной, старт идёт дальше: relay, сессии, ready", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; предел — вдвое выше самого долгого старта Host (5,9 с)
    const stuck = module("host-stuck", { start: () => new Promise<void>(() => {}) });
    const st = await stand({ sessions: [{ callsign: "site@laptop" }], modules: [stuck], start: false });
    let started = false;
    const run = st.start().then(() => (started = true));
    await until(() => lines(st, "host_start").length === 1);
    st.clock.advance(11_999);
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(false);
    st.clock.advance(1);
    await run;
    expect(lines(st, "module_failed")[0]).toMatchObject({ module: "host-stuck", why: expect.stringContaining("start() не вернулся за 12 с") });
    expect(lines(st, "ready")).toHaveLength(1);
    expect(st.kernel.sessions.get("site@laptop")!.state).toBe("idle");
  });

  it("3150 · session() модуля не возвращается при подъёме сессии — за 12 с модуль выключен в этой сессии, сессия поднимается без его вклада", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; устав «ошибка модуля — модуль выключен»
    const stuck = module("host-stuck", { session: () => new Promise<undefined>(() => {}) });
    const st = await stand({ sessions: [{ callsign: "site@laptop" }], modules: [stuck], start: false });
    const run = st.start();
    await until(() => lines(st, "host_start").length === 1);
    await new Promise((r) => setTimeout(r, 20));
    st.clock.advance(12_000);
    await run;
    expect(lines(st, "module_failed")[0]).toMatchObject({ module: "host-stuck", callsign: "site@laptop", why: expect.stringContaining("session() не вернулся за 12 с") });
    expect(st.kernel.sessions.get("site@laptop")!.state).toBe("idle");
  });

  it("3151 · процесс жив, но молчит на initialize — за 60 с строка initialize_late и kill; дальше ветка «умер»: один resume, второй сбой — failed", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; устав «процесс claude умер — один resume, второй сбой до готовности — failed»;
    // предел — как initializeTimeoutMs у startup() SDK 0.3.311 (60 с): у query() своего предела нет
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    st.holders.failInitNext = 2;
    st.proc("site@laptop").exit(1, "упал");
    await until(() => st.sdk.of("site@laptop").length === 2 && st.holders.procs.get("site@laptop")?.initializes === 1);
    st.clock.advance(60_000);
    await until(() => st.sdk.of("site@laptop").length === 3 || site.state === "failed");
    expect(lines(st, "initialize_late")).toHaveLength(1);
    expect(lines(st, "initialize_late")[0].why).toBe("процесс не ответил на initialize за 60 с — kill");
    await until(() => site.state === "failed");
    expect(st.sdk.of("site@laptop")).toHaveLength(2);
  });

  it("3173 · начатый запрос не отдаёт текущее — остановка не висит: за 30 с shutdown_late «ждёт начатые запросы», выход 1", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит и поддержка graceful shutdown»; устав «не успела — жёсткий выход»
    const slow = module("host-slow", { requests: { "slow.go": () => new Promise(() => {}) } }, { provides: { "slow.go": 1 } });
    const st = await stand({ modules: [slow] });
    void st.relay.request({ type: "slow.go", v: 1, machine: "laptop" });
    await new Promise((r) => setTimeout(r, 30));
    const down = st.kernel.shutdown("ввод закрыт");
    st.clock.advance(30_000);
    await down;
    expect(st.exits).toEqual([1]);
    expect(lines(st, "shutdown_late")[0].why).toBe("остановка не успела за 30 с: ждёт начатые запросы — жёсткий выход 1 · ввод закрыт");
  });

  it("3174 · держателей нет после перезагрузки машины — новый Host поднимает каждую сессию resume, Host доходит до ready", async () => {
    // источник: устав «процесс claude умер — один resume»; чьё: код (сессии нет среди живых — resume)
    const st = await stand({ sessions: [{ callsign: "site@laptop" }, { callsign: "wiki@laptop" }], modules: [] });
    for (const cs of ["site@laptop", "wiki@laptop"]) {
      expect(st.kernel.sessions.get(cs)!.startKind).toBe("resume");
      expect(st.kernel.sessions.get(cs)!.state).toBe("idle");
    }
    expect(lines(st, "ready")).toHaveLength(1);
  });

  it("3175 · сессия была failed у прежнего Host — новый Host пробует снова с хранилища (чистый перезапуск)", async () => {
    // источник: чьё: код (Host начинает с хранилища; решение архитектора 2 нояб. — поведение оставить)
    const st = await stand({ sessions: [{ callsign: "site@laptop", state: "failed" }], modules: [] });
    const s = st.kernel.sessions.get("site@laptop")!;
    expect(s.startKind).toBe("resume");
    expect(s.state).toBe("idle");
  });

  it("3176 · relay недоступен на старте — сессии поднимаются, Host доходит до ready; связь — переподключением", async () => {
    // источник: устав «соединение с Worker-модулем оборвалось — клиенты переподключаются»; «Часть падает… одна, остальные ждут»
    const st = await stand({ sessions: [{ callsign: "site@laptop" }], modules: [], start: false, pauseMs: 5 });
    st.relay.refuse.push("gate_unavailable");
    await st.start();
    expect(lines(st, "ready")).toHaveLength(1);
    expect(st.kernel.sessions.get("site@laptop")!.state).toBe("idle");
    await until(() => lines(st, "hello").length === 1);
  });

  it("3121 · остановка ждёт без конца (stop() модуля ждёт ответ, который потерян) — за предел 30 с строка shutdown_late с тем, чего ждёт, и жёсткий выход 1; процессы claude живут у держателей", async () => {
    // источник: слово пользователя «у всех операций должен быть лимит и поддержка graceful shutdown» (2 нояб.);
    // факт — Host 1.1.56 на 4 машинах прода и 2 теста висел в stopping: profiles.stop ждал github.token без ответа
    const k = await keeper();
    let host!: Host;
    const profiles = module("host-profiles", {
      start: (h) => void (host = h),
      stop: async () => void (await host.request("github.token", { repo: "o/r" })),
    }, { uses: { "github.token@github": 1 } });
    const st = await stand({ holders: k, modules: [profiles] });
    await st.open("site@laptop");
    let finished = false;
    const down = st.kernel.shutdown("ввод закрыт").then(() => (finished = true));
    await until(() => st.relay.frames("github.token").length === 1);
    st.clock.advance(29_999);
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(false);
    expect(st.exits).toEqual([]);
    st.clock.advance(1);
    await down;
    expect(st.exits).toEqual([1]);
    const late = lines(st, "shutdown_late");
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ kind: "stop", why: "остановка не успела за 30 с: ждёт stop() модуля host-profiles — жёсткий выход 1 · ввод закрыт" });
    expect(lines(st, "exit")).toEqual([]);
    expect([...k.procs.values()].every((x) => x.alive)).toBe(true);
  });

  it("3122 · остановка успела — таймер предела снят: выход 0 один раз, строки shutdown_late нет", async () => {
    // источник: чьё: код (штатная ветка остановки не меняется пределом)
    const st = await stand({ modules: [module("host-journal", { stop: () => {} })] });
    await st.kernel.shutdown("ввод закрыт");
    st.clock.advance(60_000);
    expect(st.exits).toEqual([0]);
    expect(lines(st, "shutdown_late")).toEqual([]);
  });

  // паузы переподключения и их рост — клиент рации (охват relay); здесь — то, что видно со стороны ядра
  it("68 · обрыв relay: ждущий запрос сразу disconnected; переподключение; новый hello — те же сессии и contract; ходы не прерывались; строк stop нет", async () => {
    let host!: Host;
    const fleet = module("host-fleet", { start: (h) => void (host = h), frames: { message: () => {} } });
    const st = await stand({ modules: [fleet, cost()], pauseMs: 5 });
    await st.open("site@laptop");
    const pid = st.proc("site@laptop").pid;
    const hello1 = st.relay.hellos[0];
    const waiting = host.request("message", { v: 1, to: "poe-bot@pc", text: "привет" });
    await until(() => st.relay.frames("message").length === 1);
    st.relay.drop(1006);
    expect(await waiting).toEqual({ ok: false, error: "disconnected" });
    await until(() => st.relay.hellos.length === 2 && lines(st, "hello").length === 2);
    const hello = st.relay.hellos.at(-1)!;
    expect(hello.contract).toEqual(hello1.contract);
    expect((hello.sessions as object[]).map((s) => (s as { callsign: string }).callsign)).toEqual(["site@laptop"]);
    expect(st.proc("site@laptop").pid).toBe(pid);
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(lines(st).filter((l) => l.ev === "hello" || l.ev === "relay_closed").map((l) => l.ev)).toEqual(["hello", "relay_closed", "hello"]);
    expect(lines(st).filter((l) => l.kind === "stop")).toEqual([]);
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

  it("152 · hello закрыт gate_unavailable дважды — переподключение, третий принят, строк stop нет; bad_key — без переподключений, stop в журнале, сессии работают", async () => {
    const st = await stand({ modules: [cost()], start: false, pauseMs: 5 });
    st.relay.refuse = ["gate_unavailable", "gate_unavailable"];
    await st.start();
    await until(() => st.relay.hellos.length === 3 && lines(st, "hello").length === 1);
    expect(lines(st).filter((l) => l.kind === "stop")).toEqual([]);
    expect(st.relay.hellos[2].contract).toEqual(st.relay.hellos[0].contract);

    const st2 = await stand({ modules: [cost()], start: false, pauseMs: 5 });
    st2.relay.refuse = ["bad_key"];
    await st2.start();
    await until(() => lines(st2, "relay_stopped").length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(st2.relay.conns).toHaveLength(1);
    expect(lines(st2, "relay_stopped")[0]).toMatchObject({ kind: "stop", word: "bad_key" });
    await st2.open("site@laptop");
    turn(st2.proc("site@laptop"));
    await until(() => st2.session("host-cost", "site@laptop")!.store<{ turns: number }>().get()?.turns === 1);
  });
});
