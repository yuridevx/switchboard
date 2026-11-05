// Леса ядра Host: настоящее ядро на стенде — поддельные SDK, relay, держатели и часы. Импорт — только контракт и стенд.
// Номер эталона — номер теста; источник свойства — в комментарии теста, без пометки — чьё: код. Процесс main.ts — boundary-process.test.ts.
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionInfo, getSessionMessages, importSessionToStore } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAME } from "@switchboard/protocol";
import { clientPath, content, isRefusal, refuse, tildePath } from "../contract.ts";
import type { Host, Module } from "../contract.ts";
import { CORE, FakeClock, FakeHolders, FakeRelay, FakeSdk, msg, module, standHost, turn, until } from "../stand/index.ts";
import type { FakeProc, Stand } from "../stand/index.ts";

/** Пределы контракта остановки: ступень остановки процесса и ожидание конца хода перед перезапуском. */
const STOP_STEP = 30_000;
const RESTART_WAIT = 6 * 3_600_000;
/** номер ядра — из его манифеста: тесты не держат его числом */
const CORE_VERSION = (JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")) as { version: string }).version;

const stands: Stand[] = [];
const keepers: FakeHolders[] = [];
const procs: FakeProc[] = [];
async function stand(o: Parameters<typeof standHost>[0] = {}): Promise<Stand> {
  const st = await standHost(o);
  stands.push(st);
  return st;
}
function keeper(): FakeHolders {
  const k = new FakeHolders();
  keepers.push(k);
  return k;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const st of stands.splice(0)) await st.close();
  for (const k of keepers.splice(0)) await k.close();
  for (const p of procs.splice(0)) await p.close();
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
const core = (st: Stand) => (JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")) as { sessions: Array<Record<string, unknown>> }).sessions;
const CS = "site@laptop";

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

  it("7303 · relay отказал пропуску машины (revoked, bad_key) — Host выходит штатно, процессы claude живут у держателей: keeper поднимет Host с нынешним machine.key", async () => {
    // источник: устав — часть машины умерла: один перезапуск, второе падение — failed; бэклог 3 нояб. «Host держит старый пропуск в памяти»
    for (const word of ["revoked", "bad_key"]) {
      const st = await stand({ modules: [] });
      const site = await st.open("site@laptop");
      const p = st.proc("site@laptop");
      st.relay.conns.at(-1)!.drop(1008, word);
      await until(() => st.exits.length === 1);
      expect(st.exits).toEqual([0]);
      expect(lines(st, "relay_stopped")[0].word).toBe(word);
      expect(p.alive).toBe(true);
      expect(site.state).not.toBe("stopped");
    }
  });

  it("7304 · состояние, сменившееся между hello и первым roster, доходит до relay после roster: сессия не остаётся starting", async () => {
    // источник: бэклог 3 нояб. — flow@wsl 20+ мин показывала starting при idle в записи, на ввод стала idle; чьё: код — relay заменяет запись кадром session.state
    const k = await keeper();
    const a = await stand({ modules: [], holders: k });
    await a.open("site@laptop");
    await a.kernel.shutdown("смена версии");
    const relayStand = new FakeRelay();
    relayStand.holdRoster = true;
    const b = await stand({ modules: [], holders: k, home: a.home, relayStand });
    const site = b.kernel.sessions.get("site@laptop")!;
    await until(() => relayStand.hellos.length === 1 && site.state === "idle");
    const inHello = (relayStand.hellos[0].sessions as Array<{ callsign: string; state: string }>).find((s) => s.callsign === "site@laptop")!;
    expect(inHello.state).toBe("starting");
    relayStand.releaseRoster();
    await until(() => relayStand.sent.some((f) => f.type === "session.state" && f.callsign === "site@laptop" && f.state === "idle"));
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

  it("7350 · ход завис: процесс не отвечает на прерывание — за предел stop убивает его, сессия stopped, причина в журнале, resume нет", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; бэклог — после 24 ч stop не завершился
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => site.state === "busy");
    p.noInterrupt = true;
    const stopping = site.stop();
    await until(() => p.interrupts === 1);
    st.clock.advance(STOP_STEP - 1);
    expect(st.holders.ops.some((o) => o.op === "kill")).toBe(false);
    st.clock.advance(1);
    await stopping;
    expect(site.state).toBe("stopped");
    expect(st.holders.ops.filter((o) => o.op === "kill")).toHaveLength(1);
    expect(lines(st, "stop_late")[0]).toMatchObject({ callsign: "site@laptop", why: expect.stringContaining("kill") });
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
  });

  it("7351 · процесс не вышел после закрытия ввода: за предел убит, stop и restart доходят до конца", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.noClose = true;
    const restarting = site.restart();
    await until(() => st.holders.ops.some((o) => o.op === "close_input"));
    st.clock.advance(STOP_STEP);
    await restarting;
    expect(st.holders.ops.filter((o) => o.op === "kill")).toHaveLength(1);
    expect(st.sdk.of("site@laptop")).toHaveLength(2);
  });

  it("7352 · restart ждёт конца хода, а stop пришёл: сессия остаётся stopped, новый процесс не поднимается", async () => {
    // источник: слово пользователя 2 нояб. — операцию можно остановить; чьё: код — restart ждёт конца хода
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => site.state === "busy");
    const restarting = site.restart();
    await site.stop();
    await restarting;
    expect(site.state).toBe("stopped");
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
  });

  it("7356 · процесс не вышел и от kill: за вторую ступень stop отказывает словом, а не висит", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; устав — отказ словом
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => site.state === "busy");
    p.noInterrupt = true;
    p.noKill = true;
    const stopping = site.stop().then(() => "ok", (e: Error) => e.message);
    await until(() => p.interrupts === 1);
    st.clock.advance(STOP_STEP);
    await until(() => st.holders.ops.some((o) => o.op === "kill"));
    st.clock.advance(STOP_STEP);
    expect(await stopping).toContain("не вышел");
    p.noKill = false;
  });

  it("7357 · ход не кончился за предел restart: перезапуск отменён с причиной в журнале, ход идёт дальше, его итог новый процесс не поднимает", async () => {
    // источник: слово пользователя 4 нояб. — таймер с отменой, предел 6 часов
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => site.state === "busy");
    let done = false;
    const restarting = site.restart().then(() => void (done = true));
    st.clock.advance(RESTART_WAIT - 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    st.clock.advance(1);
    await restarting;
    expect(lines(st, "restart_late")[0]).toMatchObject({ callsign: "site@laptop", why: expect.stringContaining("отменён") });
    expect(site.state).toBe("busy");
    expect(st.holders.ops.some((o) => o.op === "close_input" || o.op === "kill")).toBe(false);
    p.send(msg.result());
    p.send(msg.state("idle"));
    await until(() => site.state === "idle");
    await new Promise((r) => setTimeout(r, 20));
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
  });

  it("7358 · ход кончился в пределе: перезапуск идёт, таймер предела снят", async () => {
    // источник: слово пользователя 4 нояб.; чьё: код — restart между ходами
    const st = await stand({ modules: [] });
    const site = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => site.state === "busy");
    const restarting = site.restart();
    st.clock.advance(RESTART_WAIT - 1);
    p.send(msg.result());
    await restarting;
    expect(st.sdk.of("site@laptop")).toHaveLength(2);
    st.clock.advance(RESTART_WAIT);
    expect(lines(st, "restart_late")).toEqual([]);
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

  it("7353 · процесс молчит на initialize первый раз: kill даёт один выход — один resume, сессия поднялась, а не failed", async () => {
    // источник: устав, ожидаемые ветки — «процесс claude умер — один resume, второй сбой до готовности — failed»
    const st = await stand({ modules: [] });
    st.holders.failInitNext = 1;
    void st.open("site@laptop").catch(() => {});
    await until(() => st.holders.procs.get("site@laptop")?.initializes === 1);
    st.clock.advance(60_000);
    await until(() => st.sdk.of("site@laptop").length === 2 || lines(st, "session_failed").length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(lines(st, "session_failed")).toEqual([]);
    expect(lines(st, "session_exited")).toHaveLength(1);
    expect(st.states("site@laptop").at(-1)!.state).toBe("idle");
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

  it("152 · hello закрыт gate_unavailable дважды — переподключение, третий принят, строк stop нет; contract_mismatch — без переподключений, stop в журнале, сессии работают", async () => {
    const st = await stand({ modules: [cost()], start: false, pauseMs: 5 });
    st.relay.refuse = ["gate_unavailable", "gate_unavailable"];
    await st.start();
    await until(() => st.relay.hellos.length === 3 && lines(st, "hello").length === 1);
    expect(lines(st).filter((l) => l.kind === "stop")).toEqual([]);
    expect(st.relay.hellos[2].contract).toEqual(st.relay.hellos[0].contract);

    const st2 = await stand({ modules: [cost()], start: false, pauseMs: 5 });
    st2.relay.refuse = ["contract_mismatch"];
    await st2.start();
    await until(() => lines(st2, "relay_stopped").length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(st2.relay.conns).toHaveLength(1);
    expect(lines(st2, "relay_stopped")[0]).toMatchObject({ kind: "stop", word: "contract_mismatch" });
    await st2.open("site@laptop");
    turn(st2.proc("site@laptop"));
    await until(() => st2.session("host-cost", "site@laptop")!.store<{ turns: number }>().get()?.turns === 1);
  });
});

describe("старт Host", () => {
  it("700 · старт без сессий: start() модулей по порядку списка, hello с contract всех модулей, host_start и ready в журнале, on.ready один раз", async () => {
    // источник: чьё: код — контракт «Порядок старта — порядок списка модулей», «on.ready… Раз за старт Host»
    const order: string[] = [];
    const a = module("host-a", { start: () => void order.push("start a"), on: { ready: () => void order.push("ready a") }, requests: { "a.x": () => 1 } });
    const b = module("host-b", { start: () => void order.push("start b"), on: { ready: () => void order.push("ready b") }, fields: { bee: () => 1 } });
    const st = await stand({ modules: [a, b] });
    await until(() => st.relay.hellos.length === 1 && lines(st, "hello").length === 1);
    expect(order).toEqual(["start a", "start b", "ready a", "ready b"]);
    expect(st.relay.hellos[0]).toMatchObject({ contract: { "a.x": 1, bee: 1 }, sessions: [] });
    expect(lines(st, "host_start")[0].modules).toEqual(["host-a 1.0.0", "host-b 1.0.0"]);
    expect(lines(st, "ready")).toHaveLength(1);
  });

  it("701 · сессии прежнего Host: живая — attach с состоянием записи, мёртвая — resume, остановленная — stopped без процесса", async () => {
    // источник: устав «keeper умер или подменил себя — ОС поднимает его, держатели живут»; остановленная без процесса — чьё: код
    const k = keeper();
    const a = await k.addProcess("a@laptop");
    const st = await stand({
      holders: k,
      sessions: [{ callsign: "a@laptop", state: "busy" }, { callsign: "b@laptop" }, { callsign: "c@laptop", stopped: true }],
      modules: [],
    });
    expect(k.ops.filter((o) => o.id === "a@laptop").map((o) => o.op)).toEqual(["attach"]);
    expect(a.initializes).toBe(1);
    expect(st.kernel.sessions.get("a@laptop")!.state).toBe("busy");
    expect(k.spawns.map((s) => s.id)).toEqual(["b@laptop"]);
    expect(st.query("b@laptop").options.resume).toBe("sid-b");
    expect(st.kernel.sessions.get("b@laptop")!.state).toBe("idle");
    expect(st.kernel.sessions.get("c@laptop")!.state).toBe("stopped");
    expect(st.sdk.of("c@laptop")).toHaveLength(0);
    expect(lines(st, "ready")).toHaveLength(1);
  });

  it("702 · вклад session() двух владельцев на старте — Host не стартует, процесс сессии жив, relay не подключён", async () => {
    // источник: устав «у… MCP-сервера, ключа env… — один модуль; двое — Host не стартует»
    const k = keeper();
    const p = await k.addProcess(CS);
    const a = module("host-a", { session: () => ({ env: { X: "1" } }) });
    const b = module("host-b", { session: () => ({ env: { X: "2" } }) });
    const st = await stand({ holders: k, sessions: [{ callsign: CS }], modules: [a, b] });
    expect(st.startError?.reasons).toEqual(["env X: два владельца — host-a и host-b"]);
    expect(lines(st, "gate")[0]).toMatchObject({ kind: "stop", word: "check_failed", why: "env X: два владельца — host-a и host-b" });
    expect(p.alive).toBe(true);
    expect(k.ops.filter((o) => o.op === "kill" || o.op === "close_input")).toEqual([]);
    expect(st.relay.conns).toHaveLength(0);
  });

  it("703 · сессия из хранилища дважды не поднялась — failed с обеими причинами, другая idle, Host дошёл до ready", async () => {
    // источник: устав «процесс claude умер — один resume, второй сбой до готовности — failed»; «Часть падает… одна, остальные ждут»
    const k = keeper();
    const spawn = k.spawn.bind(k);
    k.spawn = async (s) => {
      const f = await spawn(s);
      if (s.id === "a@laptop") k.procs.get(s.id)!.failInit = true;
      return f;
    };
    const ready = vi.fn();
    const st = await stand({ holders: k, sessions: [{ callsign: "a@laptop" }, { callsign: "b@laptop" }], modules: [module("host-r", { on: { ready } })], start: false });
    const started = st.start();
    for (const [n, why] of [[1, "первый"], [2, "второй"]] as const) {
      await until(() => k.spawns.filter((s) => s.id === "a@laptop").length === n && k.procs.get("a@laptop")?.initializes === 1);
      k.procs.get("a@laptop")!.exit(1, why);
    }
    await started;
    expect(st.kernel.sessions.get("a@laptop")!.state).toBe("failed");
    expect(st.kernel.sessions.get("b@laptop")!.state).toBe("idle");
    const failed = lines(st, "session_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].why).toContain("первый");
    expect(failed[0].why).toContain("второй");
    expect(lines(st, "ready")).toHaveLength(1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect((st.relay.hellos[0].sessions as Array<{ callsign: string }>).map((s) => s.callsign)).toEqual(["a@laptop", "b@laptop"]);
  });

  it("704 · Host остановлен во время старта — строки ready нет, on.ready не зовётся, stop() модуля вызван, выход 0, процесс жив", async () => {
    // источник: устав «По сигналу: не принимает новое → … → выходит»; ready после остановки не пишется — чьё: код
    const ready = vi.fn();
    const stop = vi.fn();
    const st = await stand({ sessions: [{ callsign: CS }], modules: [module("host-r", { on: { ready }, stop })], start: false });
    st.holders.failInitNext = 1;
    void st.start();
    await until(() => st.holders.procs.get(CS)?.initializes === 1);
    await st.kernel.shutdown("ввод закрыт");
    await new Promise((r) => setTimeout(r, 30));
    expect(lines(st, "ready")).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(st.exits).toEqual([0]);
    expect(st.proc(CS).alive).toBe(true);
  });
});

describe("кадры и запросы из relay", () => {
  it("705 · кадр без владельца и подписчиков — строка refuse unknown_request с типом кадра", async () => {
    // источник: устав «система ловит… пишет в журнал с причиной»
    const st = await stand({ modules: [module("host-a", {})] });
    st.relay.deliver({ type: "nobody", x: 1 });
    await until(() => lines(st, "frame").some((l) => String(l.why).includes("nobody")));
    expect(lines(st, "frame").find((l) => String(l.why).includes("nobody"))).toMatchObject({ kind: "refuse", word: "unknown_request" });
  });

  it("706 · обработчик кадра бросил — модуль выключен в сессии кадра, запрос к нему — module_error", async () => {
    // источник: устав «ошибка модуля — модуль выключен, в roster failed»; «frames → кадр дальше не идёт» — чьё: код
    const a = module("host-a", { frames: { answer: () => { throw new Error("бах"); } }, requests: { "a.x": () => 1 } });
    const st = await stand({ modules: [a] });
    await st.open(CS);
    st.relay.deliver({ type: "answer", callsign: CS, from: "phone~u@example.com" });
    await until(() => st.states(CS).at(-1)?.failed?.["host-a"]);
    expect(lines(st, "module_failed")).toHaveLength(1);
    expect(lines(st, "module_failed")[0]).toMatchObject({ module: "host-a", callsign: CS });
    expect(await st.relay.request({ type: "a.x", v: 1, callsign: CS })).toMatchObject({ ok: false, error: "module_error" });
  });

  it("707 · on.frame бросил — модуль выключен на машине, другой подписчик получил оба кадра", async () => {
    // источник: устав «ошибка модуля — модуль выключен, в roster failed»; вызов без сессии — на машине — чьё: код
    const got: string[] = [];
    const a = module("host-a", { on: { frame: (f) => { got.push(`a ${f.type}`); throw new Error("бах"); } } }, { uses: { "roster@relay": 1 } });
    const b = module("host-b", { on: { frame: (f) => void got.push(`b ${f.type}`) } }, { uses: { "roster@relay": 1 } });
    const st = await stand({ modules: [a, b] });
    await until(() => got.includes("b roster"));
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [] });
    await until(() => got.filter((x) => x === "b roster").length === 2);
    expect(got.filter((x) => x === "a roster")).toHaveLength(1);
    const f = lines(st, "module_failed");
    expect(f).toHaveLength(1);
    expect(f[0].module).toBe("host-a");
    expect(f[0].callsign).toBeUndefined();
    expect(f[0].why).toContain("на машине");
    await st.open(CS);
    expect(st.states(CS).at(-1)!.failed).toHaveProperty("host-a");
  });

  it("708 · запрос из relay — reply ok с result отправителю; обработчик видит отправителя в ctx.from", async () => {
    // источник: устав «у запроса id, ответ — reply {id, ok, result | error}»; «Запрос с callsign… пересылает Host как есть»
    const seen: unknown[] = [];
    const a = module("host-a", { requests: { "a.cost": (req, ctx) => { seen.push(ctx.from); return { usd: 1, cs: req.callsign }; } } });
    const st = await stand({ modules: [a] });
    await st.open(CS);
    const r = await st.relay.request({ type: "a.cost", v: 1, callsign: CS, from: "c~u@example.com" });
    expect(r).toMatchObject({ type: "reply", ok: true, result: { usd: 1, cs: CS }, to: "c~u@example.com" });
    expect(seen).toEqual(["c~u@example.com"]);
  });

  it("709 · вход отклонён через relay: unknown_request, contract_mismatch, offline — обработчик не вызван, refuse со словом в журнале", async () => {
    // источник: устав «ошибки — словами»; «система ловит… отказывает, пишет в журнал с причиной»
    const called = vi.fn();
    const st = await stand({ modules: [module("host-a", { requests: { "a.x": called } })] });
    expect(await st.relay.request({ type: "y.do", v: 1 })).toMatchObject({ ok: false, error: "unknown_request" });
    expect(await st.relay.request({ type: "a.x", v: 2 })).toMatchObject({ ok: false, error: "contract_mismatch" });
    expect(await st.relay.request({ type: "a.x", v: 1, callsign: "none@laptop" })).toMatchObject({ ok: false, error: "offline" });
    // запрос без v — тот же отказ версии (итерация 6: v обязателен везде)
    expect(await st.relay.request({ type: "a.x" })).toMatchObject({ ok: false, error: "contract_mismatch" });
    expect(called).not.toHaveBeenCalled();
    expect(lines(st, "request").filter((l) => l.kind === "refuse").map((l) => l.word)).toEqual(["unknown_request", "contract_mismatch", "offline", "contract_mismatch"]);
  });
});

describe("связь с relay", () => {
  it("710 · hello: ключ машины, версия SDK, contract — provides всех модулей, sessions — записи roster; строка hello в журнале", async () => {
    // источник: устав «Roster — из attachments живых соединений»; состав hello — чьё: код
    const k = keeper();
    await k.addProcess("a@laptop");
    const a = module("host-a", { requests: { "a.x": () => 1 }, fields: { tag: (s) => `t-${s.info.callsign}` } });
    const b = module("host-b", { frames: { ping: () => {} } });
    const st = await stand({ holders: k, sessions: [{ callsign: "a@laptop", state: "idle" }, { callsign: "b@laptop", stopped: true }], modules: [a, b] });
    await until(() => lines(st, "hello").length === 1);
    const h = st.relay.hellos[0];
    expect(h).toMatchObject({ type: "hello", key: "host.laptop.k7f3.stand", sdk: "0.3.311", contract: { "a.x": 1, tag: 1, ping: 1 } });
    const sessions = h.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ callsign: "a@laptop", sdk: "0.3.311", tag: "t-a@laptop" });
    expect(sessions[1]).toMatchObject({ callsign: "b@laptop", state: "stopped", sdk: "0.3.311", tag: "t-b@laptop" });
  });
});

describe("процесс сессии у держателя", () => {
  it("711 · сбой после готовности снова — снова один resume, failed нет", async () => {
    // источник: устав «процесс claude умер — один resume, второй сбой до готовности — failed»: сбой после готовности — снова первый
    const st = await stand({ modules: [] });
    const s = await st.open(CS);
    for (const n of [2, 3]) {
      st.proc(CS).exit(1, `сбой ${n}`);
      await until(() => st.sdk.of(CS).length === n && s.state === "idle");
    }
    expect(lines(st, "session_exited")).toHaveLength(2);
    expect(lines(st, "session_failed")).toEqual([]);
  });

  it("712 · держатель пропал, не отдав выход, — та же ветка сбоя: session_exited «держатель пропал», resume", async () => {
    // источник: устав «процесс claude умер — один resume»; держатель пропал — процесс умер с ним — чьё: код
    const st = await stand({ modules: [] });
    const s = await st.open(CS);
    const old = st.proc(CS);
    procs.push(old);
    await old.close();
    await until(() => st.sdk.of(CS).length === 2 && s.state === "idle");
    expect(lines(st, "session_exited")[0].why).toContain("держатель пропал");
    expect(st.query(CS).options.resume).toBe(s.info.session_id);
  });

  it("713 · spawn: держатель с callsign, папкой и env сессии; ввод доходит до процесса; stop — закрытие ввода, не «убей»", async () => {
    // источник: устав «в окружении сессий DISABLE_UPDATES=1»; кадры держателя — замороженный протокол keeper (факт)
    const st = await stand({ modules: [module("host-a", { session: () => ({ env: { MY: "1" } }) })] });
    const s = await st.open(CS);
    const sp = st.holders.spawns.find((x) => x.id === CS)!;
    expect(sp.cwd).toBe(s.info.cwd);
    expect(sp.env).toMatchObject({ MY: "1", DISABLE_UPDATES: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" });
    s.input("привет");
    await until(() => st.proc(CS).inputs.length === 1);
    await s.stop();
    expect(st.holders.ops.filter((o) => o.id === CS).map((o) => o.op)).toEqual(["spawn", "attach", "close_input"]);
  });

  it("714 · attach, а файла держателя уже нет — session_exited unknown_id, resume через новый держатель", async () => {
    // источник: устав «процесс claude умер — один resume»
    const k = keeper();
    procs.push(await k.addProcess(CS));
    const files = k.files.bind(k);
    let n = 0;
    // процесс держателя пропал между списком при старте и подключением
    k.files = () => (n++ === 0 ? files() : []);
    const st = await stand({ holders: k, sessions: [{ callsign: CS }], modules: [] });
    await until(() => st.kernel.sessions.get(CS)!.state === "idle");
    expect(lines(st, "session_exited")[0].why).toContain("держатель: unknown_id");
    expect(k.spawns.map((s) => s.id)).toEqual([CS]);
    expect(st.query(CS).options.resume).toBe("sid-site");
  });

});

describe("решения и вклады", () => {
  it("716 · владелец decide решает инструмент: ответ владельца — процессу; владелец получил input и toolUseID", async () => {
    // источник: чьё: код — контракт «Решение по инструменту из canUseTool; у инструмента один владелец»
    const got: unknown[] = [];
    const a = module("host-a", { decide: { Bash: (_s, input, o) => { got.push([input, o.toolUseID]); return { behavior: "deny", message: "нельзя" }; } } });
    const st = await stand({ modules: [a] });
    await st.open(CS);
    expect(await st.proc(CS).ask("Bash", { command: "rm" }, "toolu_9")).toEqual({ behavior: "deny", message: "нельзя" });
    expect(got).toEqual([[{ command: "rm" }, "toolu_9"]]);
  });

  it("717 · host.open: callsign чужой машины, имя занято, Host останавливается — отказ, список и core.json не тронуты", async () => {
    // источник: устав «система ловит… отказывает»; «По сигналу: не принимает новое»
    const st = await stand({ modules: [] });
    await st.open(CS);
    await expect(st.kernel.open({ callsign: "x@pc", cwd: st.home })).rejects.toThrow("callsign не этой машины");
    await expect(st.kernel.open({ callsign: CS, cwd: st.home })).rejects.toThrow("имя занято");
    const down = st.kernel.shutdown("ввод закрыт");
    await expect(st.kernel.open({ callsign: "new@laptop", cwd: st.home })).rejects.toThrow("shutting_down");
    await down;
    expect([...st.kernel.sessions.keys()]).toEqual([CS]);
    expect(core(st).map((r) => r.callsign)).toEqual([CS]);
  });

  it("718 · session() бросил, другой модуль отдал опцию ядра — сессия поднята без их вкладов, оба выключены в сессии", async () => {
    // источник: устав «ошибка модуля — модуль выключен, в roster failed»; «session() → query() без вкладов модуля» — чьё: код
    const a = module("host-a", { session: () => { throw new Error("сломан"); } });
    const b = module("host-b", { session: () => ({ cwd: "/x", permissionMode: "default" }) });
    const st = await stand({ modules: [a, b] });
    const s = await st.open(CS);
    expect(s.state).toBe("idle");
    expect(st.query(CS).options).toMatchObject({ cwd: s.info.cwd, permissionMode: "bypassPermissions" });
    await until(() => st.states(CS).at(-1)?.failed?.["host-a"] && st.states(CS).at(-1)?.failed?.["host-b"]);
    expect(st.states(CS).at(-1)!.failed).toEqual({ "host-a": "сломан · session", "host-b": "опция cwd — её держит ядро · session" });
    expect(lines(st, "module_failed").map((l) => l.module).sort()).toEqual(["host-a", "host-b"]);
  });

  it("719 · процесс вышел до initialize при host.open — open отказан, один resume, второй выход — failed", async () => {
    // источник: устав «процесс claude умер — один resume, второй сбой до готовности — failed»
    const st = await stand({ modules: [] });
    st.holders.failInitNext = 2;
    const opening = st.open(CS);
    await until(() => st.holders.procs.get(CS)?.initializes === 1);
    st.proc(CS).exit(1, "первый");
    await expect(opening).rejects.toThrow("процесс вышел до initialize");
    await until(() => st.holders.spawns.length === 2 && st.holders.procs.get(CS)?.initializes === 1);
    st.proc(CS).exit(1, "второй");
    await until(() => st.kernel.sessions.get(CS)!.state === "failed");
    await new Promise((r) => setTimeout(r, 30));
    expect(st.holders.spawns).toHaveLength(2);
    expect([...st.kernel.sessions.keys()]).toEqual([CS]);
  });
});

describe("договор модуля: Host", () => {
  it("720 · probe.sdk с методом не из calls — модуль выключен, метод не вызван", async () => {
    // источник: чьё: код — контракт «calls — методы… которые модуль зовёт через s.sdk / p.sdk»
    const st = await stand({ modules: [module("host-a", {})] });
    const p = st.host("host-a").probe();
    await expect(p.sdk("accountInfo")).rejects.toThrow("accountInfo нет в calls");
    expect(st.sdk.queries.at(-1)!.calls).toEqual([]);
    expect(lines(st, "module_failed")[0]).toMatchObject({ module: "host-a" });
    p.close();
  });

  it("721 · Host останавливается — открытые пробы закрыты", async () => {
    // источник: устав «закрывает соединения с причиной → выходит»
    const st = await stand({ modules: [module("host-a", {})] });
    st.host("host-a").probe();
    const q = st.sdk.queries.at(-1)!;
    await st.close();
    expect(q.closed).toBe(true);
  });

  it("722 · host.request без связи: relay нет — disconnected; relay закрыл навсегда — disconnected; модуль не выключен", async () => {
    // источник: устав «соединение с Worker-модулем оборвалось — клиенты переподключаются»; слово disconnected — чьё: код
    let host!: Host;
    const a = module("host-a", { start: (h) => void (host = h) }, { uses: { "session.prompt@host-chat": 1 } });
    const chat = module("host-chat", { requests: { "session.prompt": () => 1 } });
    const st = await stand({ modules: [a, chat], relay: false });
    expect(await host.request("session.prompt", { v: 1, callsign: "x@pc" })).toEqual({ ok: false, error: "disconnected" });
    // relay закрыл навсегда — запрос к сессии другой машины: disconnected; Worker'ы — POST, от relay не зависят
    let host2!: Host;
    const b = module("host-b", { start: (h) => void (host2 = h) }, { uses: { "session.prompt@host-chat": 1 } });
    const st2 = await stand({ modules: [b], start: false });
    st2.relay.refuse = ["contract_mismatch"];
    await st2.start();
    await until(() => lines(st2, "relay_stopped").length === 1);
    expect(await host2.request("session.prompt", { v: 1, callsign: "x@pc" })).toEqual({ ok: false, error: "disconnected" });
    expect([...lines(st, "module_failed"), ...lines(st2, "module_failed")]).toEqual([]);
  });

  it("E3 · обработчик на своей машине завис: host.read → timeout на 10 с по часам ядра, модуль не выключен", async () => {
    // источник: слово пользователя 4 нояб. «таймаут операций на запрос метадаты 10 секунд»
    let host!: Host;
    const a = module("host-a", { start: (h) => void (host = h) }, { uses: { "x.read@host-b": 1 } });
    const b = module("host-b", { requests: { "x.read": () => new Promise(() => {}) } });
    const st = await stand({ modules: [a, b] });
    let got: unknown;
    void host.read("x.read", {}).then((r) => (got = r));
    await new Promise((r) => setTimeout(r, 5));
    st.clock.advance(9_999);
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toBeUndefined();
    st.clock.advance(1);
    await until(() => got !== undefined);
    expect(got).toEqual({ ok: false, error: "timeout" });
    expect(lines(st, "module_failed")).toEqual([]);
  });

  it("E31 · действие на своей машине идёт 150 с: ответ пришёл, timeout нет", async () => {
    // чьё: код — у запроса на своей машине предела нет: скрипт и запуск сессии ограничены своими пределами
    let host!: Host;
    let finish!: (v: unknown) => void;
    const a = module("host-a", { start: (h) => void (host = h) }, { uses: { "x.do@host-b": 1 } });
    const b = module("host-b", { requests: { "x.do": () => new Promise((ok) => (finish = ok)) } });
    const st = await stand({ modules: [a, b] });
    let got: unknown;
    void host.request("x.do", {}).then((r) => (got = r));
    await until(() => !!finish);
    st.clock.advance(150_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toBeUndefined();
    finish("готово");
    await until(() => got !== undefined);
    expect(got).toEqual({ ok: true, result: "готово" });
  });

  it("E21 · служба машины отказала с причиной: why в ответе и на своей машине, и через relay", async () => {
    // факт: так уже отвечают службы флота; решение пользователя «отказ со списком» требует, чтобы причина дошла
    let host!: Host;
    const a = module("host-a", { start: (h) => void (host = h) }, { uses: { "x.do@host-b": 1 } });
    const b = module("host-b", { requests: { "x.do": () => { throw refuse("slot_required", "Слоты машины: main, bot"); } } });
    const st = await stand({ modules: [a, b] });
    expect(await host.request("x.do", {})).toEqual({ ok: false, error: "slot_required", why: "Слоты машины: main, bot" });
    await until(() => st.relay.hellos.length === 1);
    expect(await st.relay.request({ type: "x.do", v: 1, machine: "laptop" })).toMatchObject({ ok: false, error: "slot_required", why: "Слоты машины: main, bot" });
    expect(lines(st, "module_failed")).toEqual([]);
  });

  it("5174 · владелец имени — Worker, когда он есть в адресах сборки: запрос — POST по адресу .имя; нет в адресах — к Worker'у не адресуется", async () => {
    // источник: отчёт слепого архитектора 2 нояб., пункт 9 (дубликат логики: «Worker ли владелец» — одно правило у Host и
    // страницы); устав «у каждого понятия один владелец»
    let host!: Host;
    const a = module("host-a", { start: (h) => void (host = h) }, { uses: { "push.send@push": 1, "x.do@ghost": 1 } });
    const st = await stand({ modules: [a] });
    await until(() => st.relay.hellos.length === 1);
    void host.request("push.send", { v: 1, text: "п" });
    await until(() => st.relay.sent.some((f) => f.type === "push.send"));
    expect(st.relay.sent.find((f) => f.type === "push.send")!.to).toBe(".push");
    void host.request("x.do", { v: 1 });
    await until(() => st.relay.sent.some((f) => f.type === "x.do"));
    expect(st.relay.sent.find((f) => f.type === "x.do")!.to).toBeUndefined();
    await st.close();
  });

  it("723 · host.config: свой раздел modules.<имя> из host.json; раздела нет — {}", async () => {
    // источник: чьё: код — контракт «Свой раздел modules.<имя> в host.json»
    let ca: unknown;
    let cb: unknown;
    const a = module("host-a", { start: (h) => void (ca = h.config()) });
    const b = module("host-b", { start: (h) => void (cb = h.config()) });
    await stand({ modules: [a, b], config: { modules: { "host-a": { port: 7717 } } } });
    expect(ca).toEqual({ port: 7717 });
    expect(cb).toEqual({});
  });

  it("724 · host.session — сессия по имени или undefined; host.sessions — все сессии машины, включая остановленные", async () => {
    // источник: чьё: код — контракт «сессии машины, включая остановленные»
    const st = await stand({ modules: [module("host-a", {})] });
    const h = st.host("host-a");
    await st.open("a@laptop");
    const b = await st.open("b@laptop");
    await b.stop();
    expect(h.session("a@laptop")!.info.callsign).toBe("a@laptop");
    expect(h.session("a@laptop")!.state).toBe("idle");
    expect(h.session("x@laptop")).toBeUndefined();
    expect(h.sessions()).toEqual([
      { callsign: "a@laptop", cwd: join(st.home, "work", "a"), state: "idle" },
      { callsign: "b@laptop", cwd: join(st.home, "work", "b"), state: "stopped" },
    ]);
  });
});

describe("договор модуля: сессия", () => {
  it("725 · s.restart посреди хода: ждёт result, затем закрытие, on.close, resume с новым вкладом, строка restart", async () => {
    // источник: чьё: код — контракт «Дождаться result идущего хода, close(), query() с resume»
    let n = 0;
    const closed: string[] = [];
    const a = module("host-a", { session: () => ({ append: `вклад ${++n}` }), on: { close: (s) => void closed.push(s.info.callsign) } });
    const st = await stand({ modules: [a] });
    const s = await st.open(CS);
    const sid = s.info.session_id;
    const p = st.proc(CS);
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    const restarting = s.restart();
    await new Promise((r) => setTimeout(r, 30));
    expect(st.holders.ops.filter((o) => o.op === "close_input")).toEqual([]);
    p.send(msg.result());
    p.send(msg.state("idle"));
    await restarting;
    expect(closed).toEqual([CS]);
    expect(st.query(CS).options.resume).toBe(sid);
    expect((st.query(CS).options.systemPrompt as { append: string }).append).toBe("вклад 2");
    expect(lines(st, "restart")).toHaveLength(1);
    expect(s.state).toBe("idle");
  });

  it("726 · s.restart остановленной сессии — как start: resume, idle, stopped:false", async () => {
    // источник: чьё: код — процесса нет: restart поднимает как start
    const st = await stand({ modules: [] });
    const s = await st.open(CS);
    await s.stop();
    await s.restart();
    expect(s.state).toBe("idle");
    expect(st.query(CS).options.resume).toBe(s.info.session_id);
    expect(core(st)[0].stopped).toBe(false);
  });

  it("727 · s.sdk: метод query у остановленной сессии — отказ «процесс сессии не запущен», модуль не выключен", async () => {
    // источник: чьё: код — у остановленной сессии нет query()
    const st = await stand({ modules: [module("host-a", {}, { calls: ["setModel"] })] });
    await st.open(CS);
    const s = st.session("host-a", CS)!;
    await s.stop();
    await expect(s.sdk("setModel", "claude-opus-5")).rejects.toThrow("процесс сессии не запущен");
    expect(lines(st, "module_failed")).toEqual([]);
  });

  it("728 · s.start: остановленная — resume, idle, stopped:false; живая — ничего не делает", async () => {
    // источник: чьё: код — контракт «Поднять остановленную или failed сессию по resume»
    const st = await stand({ modules: [] });
    const s = await st.open(CS);
    await s.start();
    expect(st.sdk.of(CS)).toHaveLength(1);
    await s.stop();
    expect(core(st)[0].stopped).toBe(true);
    await s.start();
    expect(s.state).toBe("idle");
    expect(st.sdk.of(CS)).toHaveLength(2);
    expect(st.query(CS).options.resume).toBe(s.info.session_id);
    expect(core(st)[0].stopped).toBe(false);
  });

  it("729 · s.stop посреди хода: interrupt, result, stopping, закрытие ввода, stopped, on.close; запись осталась; сбоя нет", async () => {
    // источник: чьё: код — контракт «interrupt → result → close(); state stopped, запись в списке остаётся»; наш close — не сбой
    const events: string[] = [];
    const a = module("host-a", { on: { close: () => void events.push("close"), state: (_s, x) => void events.push(x) } });
    const st = await stand({ modules: [a] });
    const s = await st.open(CS);
    const p = st.proc(CS);
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    events.length = 0;
    await s.stop();
    expect(p.interrupts).toBe(1);
    expect(events).toEqual(["stopping", "stopped", "close"]);
    expect(st.holders.ops.filter((o) => o.id === CS).map((o) => o.op)).toEqual(["spawn", "attach", "close_input"]);
    expect(core(st)[0].stopped).toBe(true);
    expect(lines(st, "stop")).toHaveLength(1);
    expect(lines(st, "session_exited")).toEqual([]);
    expect(st.sdk.of(CS)).toHaveLength(1);
    expect(st.host("host-a").sessions().map((x) => x.callsign)).toEqual([CS]);
  });

  it("730 · s.stop у failed-сессии без процесса — stopped сразу, держатель не тронут", async () => {
    // источник: чьё: код — процесса нет: stopped без interrupt и закрытия
    const st = await stand({ modules: [] });
    const s = await st.open(CS);
    st.holders.failInitNext = 1;
    st.proc(CS).exit(1, "первый");
    await until(() => st.holders.spawns.length === 2 && st.holders.procs.get(CS)?.initializes === 1);
    st.proc(CS).exit(1, "второй");
    await until(() => s.state === "failed");
    const ops = st.holders.ops.length;
    await s.stop();
    expect(s.state).toBe("stopped");
    expect(core(st)[0].stopped).toBe(true);
    expect(st.holders.ops).toHaveLength(ops);
  });
});

describe("штатная остановка", () => {
  it("731 · сигнал ОС и закрытие ввода вместе — одна остановка: stop() модуля один раз, одна строка exit", async () => {
    // источник: чьё: код — повторный сигнал отдаёт ту же остановку
    const stop = vi.fn();
    const st = await stand({ modules: [module("host-a", { stop })] });
    await Promise.all([st.kernel.shutdown("SIGTERM"), st.kernel.shutdown("ввод закрыт")]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(st.exits).toEqual([0]);
    expect(lines(st, "exit")).toHaveLength(1);
  });

  it("732 · stop() модуля бросил — строка module_failed, остальные остановлены, выход 0", async () => {
    // источник: устав «Каждая часть… останавливается штатно»; «stop() → строка в журнале» — чьё: код
    const order: string[] = [];
    const a = module("host-a", { stop: () => void order.push("a") });
    const b = module("host-b", { stop: () => { order.push("b"); throw new Error("не дописал"); } });
    const st = await stand({ modules: [a, b] });
    await st.close();
    expect(order).toEqual(["b", "a"]);
    expect(lines(st, "module_failed")).toHaveLength(1);
    expect(lines(st, "module_failed")[0]).toMatchObject({ module: "host-b" });
    expect(lines(st, "module_failed")[0].why).toContain("stop");
    expect(st.exits).toEqual([0]);
  });

  it("733 · начатый запрос видит сигнал остановки и отдаёт текущее; ответ ушёл до stop() модулей", async () => {
    // источник: устав «По сигналу: не принимает новое → доводит или отдаёт текущее → сохраняет своё… → выходит»
    const order: string[] = [];
    const a = module("host-a", {
      requests: {
        "a.wait": (_f, ctx) =>
          new Promise((res) => ctx.signal.addEventListener("abort", () => { order.push("отдал"); res({ partial: true }); })),
      },
      stop: () => void order.push("stop"),
    });
    const st = await stand({ modules: [a] });
    const r = st.relay.request({ type: "a.wait", v: 1 });
    await new Promise((x) => setTimeout(x, 20));
    await st.close();
    expect(await r).toMatchObject({ ok: true, result: { partial: true } });
    expect(order).toEqual(["отдал", "stop"]);
    expect(st.exits).toEqual([0]);
  });

  it("734 · модуль, выключенный на машине, — его stop() не зовётся, остальные остановлены", async () => {
    // источник: устав «ошибка модуля — модуль выключен»; stop выключенного не зовётся — чьё: код
    const stopA = vi.fn();
    const stopB = vi.fn();
    const a = module("host-a", { start: () => { throw new Error("нет конфига"); }, stop: stopA });
    const b = module("host-b", { stop: stopB });
    const st = await stand({ modules: [a, b] });
    await st.close();
    expect(stopA).not.toHaveBeenCalled();
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(st.exits).toEqual([0]);
  });
});

describe("ввод и команда claude", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("735 · content: без вложений — строка; картинка, pdf и текст — блоки по порядку, текст раскрыт", () => {
    // источник: чьё: код — контракт «без вложений — строка, иначе блоки»
    expect(content("смотри", [])).toBe("смотри");
    const got = content("смотри", [
      { name: "a.png", media_type: "image/png", data: "iVBO" },
      { name: "b.pdf", media_type: "application/pdf", data: "JVBE" },
      { name: "c.txt", media_type: "text/plain", data: b64("привет") },
    ]);
    expect(got).toEqual([
      { type: "text", text: "смотри" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBO" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "привет" } },
    ]);
  });

  it("736 · content: тип без блока — отказ словом bad_attachment с именем файла", () => {
    // источник: чьё: код — контракт «блока для типа нет — отказ bad_attachment»; устав «ошибки — словами»
    let e: unknown;
    try {
      content("x", [{ name: "a.zip", media_type: "application/zip", data: "UEsD" }]);
    } catch (x) {
      e = x;
    }
    expect(isRefusal(e)).toBe(true);
    expect((e as { word: string }).word).toBe("bad_attachment");
    expect((e as { why?: string }).why).toBe("a.zip: application/zip — блока для типа нет; во ввод ничего не ушло");
  });
});

describe("интеграция на стенде", () => {
let st: Stand | null = null;
afterEach(async () => {
  await st?.close();
  st = null;
});

describe("стенд: новая сессия и ход", () => {
  it("host.open: spawn держателя, initialize, idle; запись в core.json; on.open видит spawn; hello и session.state в relay", async () => {
    const seen: string[] = [];
    const opened: string[] = [];
    const watch: Module = { on: { event: (_s, m) => void seen.push(m.type), open: (x) => void opened.push(x.info.start) } };
    st = await standHost({ modules: [module("host-watch", watch)] });
    const s = await st.open("site@laptop");
    expect(s.state).toBe("idle");
    expect(s.info.start).toBe("spawn");
    expect(opened).toEqual(["spawn"]);
    expect(st.query("site@laptop").options.sessionId).toBe(s.info.session_id);
    const rec = (JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")) as { sessions: Array<Record<string, unknown>> }).sessions[0];
    expect(rec).toMatchObject({ callsign: "site@laptop", session_id: s.info.session_id, stopped: false });
    expect(st.journal().filter((l) => l.ev === "open" || l.ev === "launch").map((l) => `${l.ev} ${l.start ?? ""}`.trim())).toEqual(["open", "launch spawn"]);
    const p = st.proc("site@laptop");
    expect(p.env.DISABLE_UPDATES).toBe("1");
    expect(st.holders.ops.some((o) => o.op === "spawn" && o.id === "site@laptop")).toBe(true);
    expect(st.relay.hellos[0]).toMatchObject({ type: "hello", proto: 1, sdk: "0.3.311", key: "host.laptop.k7f3.stand" });
    turn(p);
    await until(() => s.state === "idle" && seen.includes("result"));
    expect(seen).toEqual(["system", "assistant", "result", "system"]);
    expect(st.states("site@laptop").map((f) => f.state)).toEqual(["starting", "idle", "busy", "idle"]);
  });

  it("s.input: сообщения user в очередь ввода — до процесса доходят по порядку с priority, uuid и origin", async () => {
    st = await standHost({ modules: [module("host-chat", {})] });
    const s = await st.open("site@laptop");
    const uuid = "00000000-0000-4000-8000-0000000000aa";
    s.input("Собери отчёт");
    s.input("Срочно", { priority: "now", uuid, origin: { kind: "x" } });
    const p = st.proc("site@laptop");
    await until(() => p.inputs.length === 2);
    expect(p.inputs[0]).toMatchObject({ type: "user", message: { role: "user", content: "Собери отчёт" } });
    expect(p.inputs[1]).toMatchObject({ type: "user", priority: "now", uuid, origin: { kind: "x" }, message: { role: "user", content: "Срочно" } });
  });

  it("system/init: модель и session_id — в s.info; новый session_id — в core.json", async () => {
    st = await standHost({ modules: [module("host-x", {})] });
    const s = await st.open("site@laptop");
    st.proc("site@laptop").send(msg.init("sid-2", "claude-opus-5"));
    await until(() => s.info.model === "claude-opus-5");
    expect(s.info.session_id).toBe("sid-2");
    const core = JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")) as { sessions: Array<{ session_id: string }> };
    expect(core.sessions[0].session_id).toBe("sid-2");
  });
});

describe("стенд: отправитель ввода", () => {
  it("314 · отправитель последнего ввода — в записи ядра на диске, ввод без from его не меняет; переживает перезапуск Host", async () => {
    // источник: принятый дизайн «Host · отправитель» — отправитель последнего ввода в записи сессии на диске; ввод без from — чьё: код
    const holders = new FakeHolders();
    st = await standHost({ machine: "win", holders, modules: [module("host-reader", {})] });
    const s = await st.open("disk-full-1@win");
    s.input("Свободно 2%", { from: "phone~owner@example.com" });
    s.input("Продолжай");
    expect(s.info.from).toBe("phone~owner@example.com");
    const core = JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")) as { sessions: Array<{ callsign: string; from?: string }> };
    expect(core.sessions.find((x) => x.callsign === "disk-full-1@win")!.from).toBe("phone~owner@example.com");
    const { home } = st;
    await st.close();
    st = await standHost({ machine: "win", home, holders, modules: [module("host-reader", {})] });
    await until(() => st!.session("host-reader", "disk-full-1@win")?.state === "idle");
    expect(st.session("host-reader", "disk-full-1@win")!.info.from).toBe("phone~owner@example.com");
    await st.close();
    st = null;
    await holders.close();
  });

  it("запрос модуля этой машины: своё имя и имя другого модуля — в процессе, без relay; отправитель — from запроса, иначе машина", async () => {
    const seen: Array<string | undefined> = [];
    const owner: Module = { requests: { who: (_f, ctx) => (seen.push(ctx.from), "я") } };
    st = await standHost({ machine: "win", modules: [module("host-owner", owner, { provides: { who: 1 } }), module("host-caller", {}, { uses: { "who@host-owner": 1 } })] });
    expect(await st.host("host-owner").request("who", { v: 1, from: "lead@win" })).toEqual({ ok: true, result: "я" });
    expect(await st.host("host-caller").request("who", { v: 1 })).toEqual({ ok: true, result: "я" });
    expect(seen).toEqual(["lead@win", "@win"]);
    expect(st.relay.frames("who")).toEqual([]);
  });

  it("s.field: поле сессии этой машины от владельца — без relay; имени нет в uses — модуль выключен в сессии", async () => {
    let got: unknown;
    const owner: Module = { fields: { parent: () => "lead@win" } };
    const reader: Module = { on: { open: (s) => void (got = s.field("parent")) } };
    const stranger: Module = { on: { open: (s) => void s.field("parent") } };
    st = await standHost({
      machine: "win",
      modules: [module("host-owner", owner), module("host-reader", reader, { uses: { "parent@host-owner": 1 } }), module("host-stranger", stranger)],
    });
    await st.open("docs@win");
    expect(got).toBe("lead@win");
    await until(() => st!.states("docs@win").at(-1)?.failed?.["host-stranger"]);
    expect(st.states("docs@win").at(-1)!.failed["host-stranger"]).toContain("parent нет в uses");
  });

  it("315 · s.field: владелец выключен в сессии — поля нет, читатель работает; failed только у владельца", async () => {
    // источник: устав — ошибка модуля: модуль выключен, в roster failed; «владелец выключен — undefined» — чьё: код (контракт ядра)
    const owner: Module = {
      fields: {
        parent: () => {
          throw new Error("поле сломано");
        },
      },
    };
    st = await standHost({ machine: "win", modules: [module("host-owner", owner), module("host-reader", {}, { uses: { "parent@host-owner": 1 } })] });
    await st.open("docs@win");
    await until(() => st!.states("docs@win").at(-1)?.failed?.["host-owner"]);
    expect(st.session("host-reader", "docs@win")!.field("parent")).toBeUndefined();
    st.session("host-reader", "docs@win")!.refresh();
    expect(Object.keys(st.states("docs@win").at(-1)!.failed)).toEqual(["host-owner"]);
  });

});

describe("стенд: запрос модуля этой машины — ветки ядра", () => {
  it("317 · обработчик владельца упал — module_error, владелец выключен в сессии запроса, причина в журнале; дальше — module_error без вызова, другой модуль отвечает", async () => {
    // источник: устав — ошибка модуля: модуль выключен, в roster failed; слово module_error — чьё: код
    let calls = 0;
    const owner: Module = {
      requests: {
        who: () => {
          calls++;
          throw new Error("бах");
        },
      },
    };
    const other: Module = { requests: { ping: () => "pong" } };
    st = await standHost({ machine: "win", modules: [module("host-owner", owner), module("host-other", other), module("host-caller", {}, { uses: { "who@host-owner": 1 } })] });
    await st.open("docs@win");
    expect(await st.host("host-caller").request("who", { v: 1, callsign: "docs@win" })).toEqual({ ok: false, error: "module_error" });
    await until(() => st!.states("docs@win").at(-1)?.failed?.["host-owner"]);
    expect(st.journal().some((l) => l.ev === "module_failed" && l.module === "host-owner" && l.callsign === "docs@win" && String(l.why).includes("бах"))).toBe(true);
    expect(await st.relay.request({ type: "who", v: 1, callsign: "docs@win" })).toMatchObject({ ok: false, error: "module_error" });
    expect(calls).toBe(1);
    expect(await st.relay.request({ type: "ping", v: 1, callsign: "docs@win" })).toMatchObject({ ok: true, result: "pong" });
  });

  it("318 · Host останавливается — запрос из stop() модуля отклонён shutting_down, кадр из relay не идёт владельцу; владелец не вызван", async () => {
    // источник: устав, штатная остановка — «не принимает новое»; слово shutting_down — чьё: код
    let called = 0;
    let got: unknown;
    let host!: Host;
    const owner: Module = { requests: { who: () => void called++ }, frames: { poke: () => void called++ } };
    const caller: Module = {
      start: (h) => void (host = h),
      stop: async () => {
        st!.relay.deliver({ type: "poke", callsign: "docs@win" });
        got = await host.request("who", { v: 1 });
      },
    };
    st = await standHost({ machine: "win", modules: [module("host-owner", owner), module("host-caller", caller, { uses: { "who@host-owner": 1 } })] });
    await st.close();
    expect(got).toEqual({ ok: false, error: "shutting_down" });
    expect(called).toBe(0);
    expect(st.journal().some((l) => l.ev === "request" && l.word === "shutting_down")).toBe(true);
    st = null;
  });
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

  it("748 · папка для клиента — обратное к clientPath: «~», «~/…» через «/»; на Windows — и путь с «/», и регистр диска любой", () => {
    // источник: прод 3 нояб. — на hz-win11 папка сессии в roster шла полным путём C:/Users/admin/projects
    const home = join(tmpdir(), "u");
    expect(tildePath(home, home)).toBe("~");
    expect(tildePath(join(home, "a", "b"), home)).toBe("~/a/b");
    expect(tildePath(join(tmpdir(), "srv"), home)).not.toMatch(/^~/);
    if (process.platform === "win32") {
      expect(tildePath("C:/Users/admin/projects", String.raw`C:\Users\admin`)).toBe("~/projects");
      expect(tildePath(String.raw`c:\Users\Admin\poe1-proj`, String.raw`C:\Users\admin`)).toBe("~/poe1-proj");
      expect(tildePath("C:/Users/admin", String.raw`C:\Users\admin`)).toBe("~");
    }
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
    const r = { type: "roster", machines: [], sessions: [], clients: ["phone~owner@example.com"] };
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

  it("E20 · запрос о сессии, которой нет: и через relay, и от модуля этой машины — offline, обработчик не вызван, модуль жив", async () => {
    // источник: чьё: код — адресата нет; принятый дизайн: значение «до старта» едет запросом открытия
    let host!: Host;
    const asked: unknown[] = [];
    const owner = module("host-manage", { requests: { "session.spec": (req) => (asked.push(req.callsign), { ok: true }) } });
    const caller = module("host-points", { start: (h) => void (host = h) }, { uses: { "session.spec@host-manage": 1 } });
    const st = await stand({ modules: [owner, caller] });
    await st.open("site@laptop");
    expect(await host.request("session.spec", { v: 1, callsign: "gone@laptop" })).toMatchObject({ ok: false, error: "offline" });
    expect(await st.relay.request({ type: "session.spec", v: 1, callsign: "gone@laptop" })).toMatchObject({ ok: false, error: "offline" });
    expect(asked).toEqual([]);
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
    expect(await host.request("session.spec", { v: 1, callsign: "site@laptop" })).toMatchObject({ ok: true });
  });

  it("E10 · отказ в запросе открытия: наружу со словом; нет процесса, папки, записи ядра и разделов; следующее открытие имени с чистого", async () => {
    // источник: слово пользователя 4 нояб. — два слота без названного: отказ со списком; проход архитектора: повторное открытие брало старую запись
    const reader = module("host-logins", {
      opening(s, req) {
        s.store<{ slot?: unknown }>().set({ slot: req.slot });
        if (req.slot === undefined) throw refuse("slot_required", "Слоты машины: main, bot");
      },
      session: (s) => ((s.store<{ slot?: string }>().get()?.slot ? { env: { SLOT_DIR: s.store<{ slot: string }>().get()!.slot } } : undefined)),
    });
    const st = await stand({ modules: [reader] });
    const cwd = join(st.home, "new-dir");
    await expect(st.open("job@laptop", { cwd, mkdir: true, opening: {} })).rejects.toMatchObject({ word: "slot_required", why: "Слоты машины: main, bot" });
    expect(existsSync(cwd)).toBe(false);
    expect(st.kernel.sessions.has("job@laptop")).toBe(false);
    expect(st.sdk.queries.length).toBe(0);
    // раздел модуль успел записать до отказа: он стёрт
    expect(JSON.parse(readFileSync(join(st.home, "store", "host-logins.json"), "utf8")).sessions?.["job@laptop"]).toBeUndefined();
    const s = await st.open("job@laptop", { cwd, mkdir: true, opening: { slot: "bot" } });
    expect(existsSync(cwd)).toBe(true);
    expect(st.proc("job@laptop").env.SLOT_DIR).toBe("bot");
    expect(s.info.callsign).toBe("job@laptop");
    await st.close();
    const again = await standHost({ home: st.home, modules: [module("host-logins", { opening() {}, session: (x) => ({ env: { SLOT_DIR: String(x.store<{ slot: string }>().get()?.slot) } }) })] });
    stands.push(again);
    await until(() => again.kernel.sessions.get("job@laptop")?.state === "idle");
    expect(again.proc("job@laptop").env.SLOT_DIR).toBe("bot");
  });

  it("E35 · модуль с opening выключен: module_error, сессии нет; его поля в запросе нет у читателя со списком — открытие идёт; упал в opening — module_error", async () => {
    // источник: чьё: код — названный слот при выключенном модуле отказывал module_error; находка архитектора: иначе сессия тихо шла бы на общий вход
    const always = module("host-logins", { requests: { "x.boom": () => { throw new Error("бах"); } }, opening() {} });
    const onlyField = module("host-profiles", { requests: { "y.boom": () => { throw new Error("бах"); } }, opening() {}, openingReads: ["profile"] });
    const st = await stand({ modules: [always, onlyField] });
    expect(await st.relay.request({ type: "y.boom", v: 1, machine: "laptop" })).toMatchObject({ error: "module_error" });
    await expect(st.open("a@laptop", { opening: { profile: "ops" } })).rejects.toMatchObject({ word: "module_error" });
    await st.open("b@laptop", { opening: {} });
    expect(await st.relay.request({ type: "x.boom", v: 1, machine: "laptop" })).toMatchObject({ error: "module_error" });
    await expect(st.open("c@laptop", { opening: {} })).rejects.toMatchObject({ word: "module_error" });
    expect(st.kernel.sessions.has("a@laptop")).toBe(false);
    expect(st.kernel.sessions.has("c@laptop")).toBe(false);
    const fall = await stand({ modules: [module("host-logins", { opening() { throw new Error("бах"); } })] });
    await expect(fall.open("d@laptop", { opening: {} })).rejects.toMatchObject({ word: "module_error" });
    expect(fall.journal().some((l) => l.ev === "module_failed" && String(l.why).includes("opening"))).toBe(true);
  });

  it("E35 · отказ словом в session() сохранённой сессии: Host стартует, модуль выключен в этой сессии", async () => {
    // источник: находка архитектора — отказ из session() на старте давал StartError на всю машину
    let refusing = false;
    const m = () => module("host-profiles", { session: () => { if (refusing) throw refuse("no_profile", "профиля больше нет"); return undefined; } });
    const a = await stand({ modules: [m()] });
    await a.open("site@laptop");
    await a.close();
    refusing = true;
    const b = await standHost({ home: a.home, modules: [m()] });
    stands.push(b);
    await until(() => b.kernel.sessions.get("site@laptop")?.state === "idle");
    await until(() => (b.states("site@laptop").at(-1)?.failed as Record<string, string>)?.["host-profiles"]);
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

  it("roster сессии несёт dir — папку от ~ — и by — отправителя последнего ввода; by меняется с вводом; поля from в session.state нет", async () => {
    let sess!: import("../contract.ts").Session;
    const probe = module("host-probe", { on: { open: (s) => void (sess = s) } });
    const st = await stand({ modules: [probe] });
    await st.open("site@laptop");
    const { homedir } = await import("node:os");
    const want = sess.info.cwd === homedir() ? "~" : sess.info.cwd.startsWith(homedir()) ? "~/" + sess.info.cwd.slice(homedir().length + 1).split(/[\\/]/).join("/") : sess.info.cwd;
    expect(st.states("site@laptop").at(-1)).toMatchObject({ dir: want });
    sess.input("привет", { from: "phone~you@mail" });
    sess.refresh();
    await until(() => st.states("site@laptop").at(-1)?.by === "phone~you@mail");
    // from в кадре — адрес отправителя: relay не доставляет кадр с чужим from (живой флот 3 нояб.)
    expect(st.relay.frames("session.state").every((f) => !("from" in f) || f.from === undefined)).toBe(true);
    sess.input("ещё", { from: "pult~you@mail" });
    sess.refresh();
    await until(() => st.states("site@laptop").at(-1)?.by === "pult~you@mail");
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
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [] });
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
    expect(st.sdk.fnCalls.at(-1)).toMatchObject({ name: "getSessionMessages", args: [s.info.session_id, { dir: s.info.cwd, limit: 5 }] });
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

  it("751 · ошибка в работе модуля вне вызова ядра (таймер из start, цепочка из обработчика запроса сессии a@) — модуль выключен там, где начал; b@, Host и другие модули работают", async () => {
    // источник: устав «часть падает и перезапускается одна», ветка «ошибка модуля — модуль выключен» (в этой сессии); факт 2 нояб. — отказ цепочки host-profiles уронил весь Host
    let st!: Awaited<ReturnType<typeof stand>>;
    let timerDone!: Promise<void>;
    let chainDone!: Promise<void>;
    const bad = module("host-bad", {
      // как обработчик процесса: ошибка вне вызова — ядру; контекст модуля наследуется таймером
      start: () => void (timerDone = new Promise((r) => setTimeout(() => (st.kernel.stray(new Error("таймер упал")), r()), 0))),
      requests: { "bad.x": () => 1 },
    });
    const chain = module("host-chain", {
      requests: {
        // цепочка без await, начатая в обработчике запроса о сессии a@, — контекст этой сессии
        "chain.go": () => void (chainDone = Promise.resolve().then(() => void st.kernel.stray(new Error("цепочка упала")))),
        "chain.x": () => 3,
      },
    });
    const good = module("host-good", { requests: { "good.x": () => 2 } });
    st = await stand({ modules: [bad, chain, good] });
    await timerDone;
    expect(st.journal().find((l) => l.ev === "module_failed" && l.module === "host-bad")!.why).toContain("модуль выключен на машине");
    await st.open("a@laptop");
    await st.open("b@laptop");
    expect(await st.relay.request({ type: "chain.go", v: 1, callsign: "a@laptop" })).toMatchObject({ ok: true });
    await chainDone;
    await until(() => st.states("a@laptop").at(-1)?.failed?.["host-chain"]);
    expect(st.states("a@laptop").at(-1)!.failed).toMatchObject({ "host-bad": "таймер упал · работа вне вызова ядра", "host-chain": "цепочка упала · работа вне вызова ядра" });
    expect(await st.relay.request({ type: "chain.x", v: 1, callsign: "a@laptop" })).toMatchObject({ ok: false, error: "module_error" });
    expect(await st.relay.request({ type: "chain.x", v: 1, callsign: "b@laptop" })).toMatchObject({ ok: true, result: 3 });
    expect(st.states("b@laptop").at(-1)!.failed?.["host-chain"]).toBeUndefined();
    expect(await st.relay.request({ type: "good.x", v: 1 })).toMatchObject({ ok: true, result: 2 });
    // вне контекста модуля — не наше: решает процесс
    expect(st.kernel.stray(new Error("ничья"))).toBe(false);
  });

  it("755 · таймер из start() шлёт кадр чужого имени — нарушение договора: модуль выключен, stray поймал без второй строки", async () => {
    // источник: устав «ошибка модуля — модуль выключен»; чьё: код (violation — «договор», ошибка помечена обработанной)
    let st!: Awaited<ReturnType<typeof stand>>;
    let caught: boolean | undefined;
    let done!: Promise<void>;
    const m = module("host-bad", {
      start: (h: Host) =>
        void (done = new Promise((r) =>
          setTimeout(() => {
            try {
              h.emit({ type: "foreign.frame" });
            } catch (e) {
              // как обработчик процесса uncaughtException
              caught = st.kernel.stray(e);
            }
            r();
          }, 0),
        )),
    });
    st = await stand({ modules: [m] });
    await done;
    expect(caught).toBe(true);
    const lines = st.journal().filter((l) => l.ev === "module_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ module: "host-bad" });
    expect(String(lines[0].why)).toContain("договор");
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

describe("стенд", () => {
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

describe("хранилище глазами модуля", () => {
  const owner = (name: string) => module(name, {});
  const file = (st: Stand, name: string) => JSON.parse(readFileSync(join(st.home, "store", `${name}.json`), "utf8"));

  it("разделы машины и сессии; запись сразу целым JSON; remove стирает разделы сессии у всех", async () => {
    // источник: контракт Store «запись сразу: временный файл и rename, файл всегда целый JSON»; контракт Session.remove
    const st = await stand({ modules: [owner("host-slots"), owner("host-cost"), owner("m")] });
    await st.open("site@laptop");
    await st.open("wiki@laptop");
    st.host("host-slots").store<string[]>().set(["y0902"]);
    st.session("host-cost", "site@laptop")!.store<number>().set(1);
    st.session("host-cost", "wiki@laptop")!.store<number>().update((c = 0) => c + 2);
    st.session("host-slots", "site@laptop")!.store<string>().set("main");
    expect(file(st, "host-cost")).toEqual({ sessions: { "site@laptop": 1, "wiki@laptop": 2 } });
    expect(readdirSync(join(st.home, "store")).some((f) => f.endsWith(".tmp"))).toBe(false);
    await st.session("host-cost", "site@laptop")!.remove();
    expect(file(st, "host-cost")).toEqual({ sessions: { "wiki@laptop": 2 } });
    expect(file(st, "host-slots")).toEqual({ machine: ["y0902"], sessions: {} });
    // get отдаёт копию: правка без set не меняет раздел; update пишет сразу и отдаёт новое значение
    const m = st.host("m").store<{ a: number }>();
    m.set({ a: 1 });
    m.get()!.a = 5;
    expect(m.get()).toEqual({ a: 1 });
    expect(m.update((v) => ({ a: v!.a + 1 }))).toEqual({ a: 2 });
    expect(file(st, "m")).toEqual({ machine: { a: 2 } });
  });

  it("753 · set(undefined) раздела машины — после перечтения undefined, ключа machine в файле нет; раздел сессии цел", async () => {
    // источник: чьё: код; контракт Store «файл всегда целый JSON»
    const st = await stand({ modules: [owner("m")] });
    await st.open("site@laptop");
    st.host("m").store<{ a: number }>().set({ a: 1 });
    st.session("m", "site@laptop")!.store<number>().set(3);
    st.host("m").store().set(undefined);
    expect(st.host("m").store().get()).toBeUndefined();
    expect(file(st, "m")).toEqual({ sessions: { "site@laptop": 3 } });
    st.session("m", "site@laptop")!.store().set(undefined);
    expect(file(st, "m")).toEqual({ sessions: {} });
  });

  it("754 · рядом недописанный A.json.tmp — новый Host читает прежний A.json; после set файл целый, .tmp нет", async () => {
    // источник: устав «Чистый перезапуск — начинает с хранилища»; контракт Store
    const a = await standHost({ modules: [owner("A")] });
    a.host("A").store<{ a: number }>().set({ a: 1 });
    await a.close();
    writeFileSync(join(a.home, "store", "A.json.tmp"), '{"machine":{"a":');
    const st = await stand({ home: a.home, modules: [owner("A")] });
    expect(st.host("A").store().get()).toEqual({ a: 1 });
    st.host("A").store<{ a: number }>().set({ a: 2 });
    expect(file(st, "A")).toEqual({ machine: { a: 2 } });
    expect(existsSync(join(st.home, "store", "A.json.tmp"))).toBe(false);
  });

  it("новый Host на той же папке читает разделы и записи ядра с диска", async () => {
    // источник: устав «После перезапуска Host модуль поднимает своё из хранилища»
    const k = keeper();
    const a = await standHost({ holders: k, modules: [owner("m")] });
    await a.open("site@laptop");
    a.session("m", "site@laptop")!.store<number>().set(7);
    a.host("m").store<string>().set("машина");
    a.crash();
    const b = await stand({ holders: k, home: a.home, modules: [owner("m")] });
    expect(b.session("m", "site@laptop")!.store().get()).toBe(7);
    expect(b.host("m").store().get()).toBe("машина");
  });
});

describe("протокол держателя: байты, как их читает keeper", () => {
  /** Держатель без единой строки кода Host: TCP и кадры руками. Копит байты от Host, шлёт байты, какие скажет тест. */
  async function rawHolder(id: string) {
    const got: Buffer[] = [];
    let sock: net.Socket | null = null;
    const server = net.createServer((s) => {
      sock = s;
      s.on("error", () => {});
      s.on("data", (d) => got.push(d));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    return {
      file: { id, owner: "host", pid: 4242, port, key: "key" },
      bytes: () => Buffer.concat(got).toString("latin1"),
      send: (b: Buffer | string) => sock!.write(typeof b === "string" ? Buffer.from(b, "latin1") : b),
      connected: () => !!sock,
      end: () => sock?.destroy(),
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }
  /** Кадр рукой: тип, длина 4 байта big-endian, данные. */
  const raw = (t: string, data = "") => {
    const b = Buffer.from(data);
    const h = Buffer.alloc(5);
    h.write(t, 0, "latin1");
    h.writeUInt32BE(b.length, 1);
    return Buffer.concat([h, b]);
  };

  it("байты кадров — образец замороженного протокола keeper: ключ первым, ввод, закрытие ввода; выход приходит кусками", async () => {
    // источник: шапка протокола держателя «заморожен»; тот же образец проверяет keeper
    const h = await rawHolder(CS);
    const holders = { spawn: async () => h.file, files: () => [] as never[], close: async () => {} } as unknown as FakeHolders;
    const st = await stand({ holders });
    const opening = st.open(CS);
    await until(() => h.bytes().includes('"$":"initialize"'));
    // первым кадром — ключ: тип a, длина 3, байты ключа
    expect(h.bytes().startsWith("a\x00\x00\x00\x03key")).toBe(true);
    expect(h.bytes().slice(8, 9)).toBe("i");
    // hello и вывод: кадр вывода разрезан на куски посреди заголовка и данных
    h.send(raw("h", JSON.stringify({ pid: 4242, buffered: 0 })));
    const line = raw("o", JSON.stringify({ $: "initialized" }) + "\n");
    h.send(line.subarray(0, 3));
    await new Promise((r) => setTimeout(r, 10));
    h.send(line.subarray(3, 9));
    await new Promise((r) => setTimeout(r, 10));
    h.send(line.subarray(9));
    const s = await opening;
    expect(s.state).toBe("idle");
    const stopping = s.stop();
    await until(() => h.bytes().endsWith("c\x00\x00\x00\x00"));
    // кадр выхода кусками: образец из протокола
    const x = Buffer.from('x\x00\x00\x00\x25{"code":0,"signal":null,"stderr":"e"}', "latin1");
    h.send(x.subarray(0, 3));
    await new Promise((r) => setTimeout(r, 10));
    h.send(x.subarray(3));
    await stopping;
    expect(s.state).toBe("stopped");
    h.end();
    await h.close();
  });

  it("чужой держатель: kill — кадр k после ключа; слово отказа держателя — выход процесса со словами", async () => {
    // источник: шапка протокола; устав «процесс claude умер — один resume»
    const orphan = await rawHolder("old@laptop");
    const holders = { spawn: async () => { throw new Error("нельзя"); }, files: () => [orphan.file], close: async () => {} } as unknown as FakeHolders;
    const started = standHost({ holders });
    await until(() => orphan.bytes().endsWith("k\x00\x00\x00\x00"));
    expect(orphan.bytes()).toBe("a\x00\x00\x00\x03keyk\x00\x00\x00\x00");
    orphan.send(raw("e", "unknown_id"));
    const st = await started;
    stands.push(st);
    expect(lines(st, "orphan_kill")[0]).toMatchObject({ kind: "stop", callsign: "old@laptop" });
    orphan.end();
    await orphan.close();
  });

  it("держатель не поднялся: spawn отказал — причина со словами «держатель:» в журнале, второй сбой — failed", async () => {
    // источник: устав «второй сбой до готовности — failed»
    const holders = { spawn: async () => { throw new Error("нет файла"); }, files: () => [] as never[], close: async () => {} } as unknown as FakeHolders;
    const st = await stand({ holders });
    await expect(st.open(CS)).rejects.toThrow("процесс вышел до initialize");
    await until(() => st.kernel.sessions.get(CS)!.state === "failed");
    expect(lines(st, "session_exited").map((l) => l.why)).toEqual(["процесс claude вышел, код null: держатель: нет файла", "процесс claude вышел, код null: держатель: нет файла"]);
    expect(lines(st, "session_failed")[0].why).toBe("второй сбой до готовности — сессия стоит до session.start: код null: держатель: нет файла · код null: держатель: нет файла");
  });
});

describe("очередь ввода", () => {
  it("ввод переживает смену процесса: дошедшее — у прежнего, новое — только у нового, пачка до готовности — по порядку", async () => {
    // источник: контракт Session.input «Очередь живёт в ядре и переживает resume»
    const k = keeper();
    const st = await stand({ holders: k });
    const s = await st.open(CS);
    const first = st.proc(CS);
    s.input("1");
    await until(() => first.inputs.length === 1);
    first.exit(1, "упал");
    await until(() => st.sdk.of(CS).length === 2);
    s.input("2");
    s.input("3");
    await until(() => st.kernel.sessions.get(CS)!.state === "idle");
    const second = st.proc(CS);
    await until(() => second.inputs.length === 2);
    expect(second.inputs.map((m) => m.message.content)).toEqual(["2", "3"]);
    expect(first.inputs.map((m) => m.message.content)).toEqual(["1"]);
    s.input("4");
    await until(() => second.inputs.length === 3);
    expect(first.inputs).toHaveLength(1);
  });
});

describe("гейт старта Host", () => {
  const e = (name: string, mod: Module, extra: Parameters<typeof module>[2] = {}) => module(name, mod, extra);

  it("ошибки набора — Host не стартует: два decide, имена участников рации без relay; причины строками журнала", async () => {
    // источник: устав «двое — Host не стартует»
    const st = await stand({
      relay: false,
      modules: [
        e("host-q1", { decide: { AskUserQuestion: () => ({ behavior: "allow" }) } }),
        e("host-q2", { decide: { AskUserQuestion: () => ({ behavior: "allow" }) } }),
        e("host-k", {}, { uses: { "keeper.state@keeper": 1 } }),
        e("host-k2", {}, { uses: { "spawn@keeper": 1 } }),
        e("host-p", {}, { uses: { "push.send@push": 1 } }),
      ],
    });
    expect(st.startError!.reasons).toEqual([
      "host-k: keeper.state@keeper — нет relay в списке сборки",
      "host-k2: spawn@keeper — нет relay в списке сборки",
      "host-p: push.send@push — нет relay в списке сборки",
      "decide.AskUserQuestion: два владельца — host-q1 и host-q2",
    ]);
    expect(lines(st, "gate").map((l) => [l.kind, l.word])).toEqual(Array(4).fill(["stop", "check_failed"]));
  });

  it("ошибка устройства одного модуля — выключен он, остальные работают: обработчик не из provides, имя ядра в fields, calls мимо SDK и метод ядра", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб.): ошибка кода модуля — модуль failed, Host работает
    const bad = e("host-a", { requests: { x: () => 1 } });
    bad.manifest.provides = {};
    const frameBad = e("host-f", { frames: { y: () => {} } });
    frameBad.manifest.provides = {};
    const fieldBad = e("host-g", { fields: { z: () => 1 } });
    fieldBad.manifest.provides = {};
    const decideBad = e("host-d", { decide: { Bash: () => ({ behavior: "allow" }) } });
    decideBad.manifest.provides = {};
    const elicitBad = e("host-e", { elicit: async () => ({ action: "decline" }) });
    elicitBad.manifest.provides = {};
    const st = await stand({
      modules: [
        bad,
        frameBad,
        fieldBad,
        decideBad,
        elicitBad,
        e("host-b", { fields: { state: () => 1 } }),
        e("host-c", {}, { calls: ["getContextUsage", "close", "nope"] }),
        e("host-ok", { requests: { "ok.do": () => "да" } }),
      ],
    });
    expect(st.startError).toBeNull();
    const why = (m: string) => lines(st, "module_failed").find((l) => l.module === m)!.why as string;
    expect(why("host-a")).toContain("host-a: requests.x — нет в provides");
    expect(why("host-f")).toContain("host-f: frames.y — нет в provides");
    expect(why("host-g")).toContain("host-g: fields.z — нет в provides");
    expect(why("host-d")).toContain("host-d: decide.Bash — нет в provides");
    expect(why("host-e")).toContain("host-e: elicit — нет в provides");
    expect(why("host-b")).toContain("host-b: поле state — имя ядра");
    expect(why("host-c")).toContain("host-c: calls close — метод держит ядро; host-c: calls nope — такого метода нет в SDK");
    for (const m of ["host-a", "host-b", "host-c"]) expect(why(m)).toContain("гейт старта");
    expect(why("host-a")).toContain("модуль выключен на машине");
    expect(await st.relay.request({ type: "ok.do", v: 1 })).toMatchObject({ ok: true, result: "да" });
    expect(await st.relay.request({ type: "x", v: 1 })).toMatchObject({ ok: false, error: "unknown_request" });
    expect(lines(st, "ready")).toHaveLength(1);
  });

  it("имя ядра в fields — каждое: callsign, state, failed, sdk, dir, by", async () => {
    // источник: чьё: код — поля записи сессии держит ядро
    const names = ["callsign", "state", "failed", "sdk", "dir", "by"];
    const st = await stand({ modules: names.map((n, i) => e(`host-${i}`, { fields: { [n]: () => 1 } })) });
    names.forEach((n, i) => expect(lines(st, "module_failed").find((l) => l.module === `host-${i}`)!.why).toContain(`host-${i}: поле ${n} — имя ядра`));
  });

  it("годный набор: Worker-имя и keeper.state через relay, uses между модулями той же версии, calls из SDK и исключения устава", async () => {
    // источник: устав, исключения SDK — вход аккаунта, Remote Control, методы вне публичных типов
    const calls = ["enableRemoteControl", "getSessionMessages", "askSideQuestion", "getTaskOutput", "cancelAsyncMessage", "mcpAuthenticate", "getStatus", "getHooksListing", "claudeAuthenticate", "claudeOAuthCallback", "claudeOAuthWaitForCompletion"];
    const st = await stand({
      modules: [
        e("host-watch", { requests: { "session.watchers": () => [] } }),
        e("host-questions", {}, { uses: { "session.watchers@host-watch": 1, "roster@relay": 1, "keeper.state@keeper": 1, "host.module@host": 1 }, calls }),
      ],
    });
    expect(st.startError).toBeNull();
    expect(lines(st, "module_failed")).toEqual([]);
  });

  it("каждый метод ядра в calls модуля — метод держит ядро", async () => {
    // источник: чьё: код — close завершает процесс, ввод — очередь ядра, серверы MCP меняет ядро
    const names = ["close", "streamInput", "setMcpServers", "reinitialize"];
    const st = await stand({ modules: names.map((n, i) => e(`host-${i}`, {}, { calls: [n] })) });
    names.forEach((n, i) => expect(lines(st, "module_failed").find((l) => l.module === `host-${i}`)!.why).toContain(`calls ${n} — метод держит ядро`));
  });
});

const sdk = { getSessionInfo, getSessionMessages, importSessionToStore } as never as Record<string, (...a: any[]) => Promise<unknown>>;
const SID = "44444444-4444-4444-8444-444444444444";
const base = { sessionId: SID, isSidechain: false, timestamp: "2026-11-03T00:00:00.000Z", cwd: "/proj", version: "2.1.0" };
const line = (uuid: string, parentUuid: string | null, type: "user" | "assistant" = "user") => ({
  ...base,
  type,
  uuid,
  parentUuid,
  message: type === "user" ? { role: "user", content: `текст ${uuid}` } : { id: `m-${uuid}`, role: "assistant", model: "m", content: [{ type: "text", text: uuid }] },
});
const boundary = (uuid: string, logicalParentUuid: string, meta: object = {}) => ({
  ...base,
  type: "system",
  subtype: "compact_boundary",
  uuid,
  parentUuid: null,
  logicalParentUuid,
  compactMetadata: { trigger: "auto", preTokens: 1000, ...meta },
});
const summary = (uuid: string, parentUuid: string) => ({ ...line(uuid, parentUuid), isCompactSummary: true });

/** n сообщений цепочкой: u0 ← a1 ← u2 … */
function chain(prefix: string, n: number, parent: string | null): Array<ReturnType<typeof line>> {
  const out = [];
  let p = parent;
  for (let i = 0; i < n; i++) {
    const u = `${prefix}${i}`;
    out.push(line(u, p, i % 2 ? "assistant" : "user"));
    p = u;
  }
  return out;
}

describe("слова журнала и отказов: их читает агент", () => {
  const STOP_WHY = "нет итога хода после прерывания за 30 с — kill";
  const CLOSE_WHY = "нет выхода процесса после закрытия ввода за 30 с — kill";

  it("строки остановки по пределу и отказ второй ступени — дословно", async () => {
    // источник: устав «пишет в журнал с причиной»; слова — чьё: код
    const st = await stand({ modules: [] });
    const site = await st.open(CS);
    const p = st.proc(CS);
    p.send(msg.state("running"));
    await until(() => site.state === "busy");
    p.noInterrupt = true;
    const stopping = site.stop().then(() => "ok", (e: Error) => e.message);
    await until(() => p.interrupts === 1);
    p.noKill = true;
    st.clock.advance(STOP_STEP);
    await until(() => st.holders.ops.some((o) => o.op === "kill"));
    st.clock.advance(STOP_STEP);
    expect(await stopping).toBe(`${CS}: процесс не вышел и через 30 с после kill`);
    expect(lines(st, "stop_late").map((l) => [l.kind, l.callsign, l.why])).toEqual([["stop", CS, STOP_WHY]]);
    p.noKill = false;
  });

  it("закрытие ввода без выхода: строка stop_late дословно; остановка ждёт и у живой сессии без хода", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; слова — чьё: код
    const st = await stand({ modules: [] });
    const site = await st.open(CS);
    st.proc(CS).noClose = true;
    const stopping = site.stop();
    await until(() => st.holders.ops.some((o) => o.op === "close_input"));
    expect(site.state).toBe("stopping");
    st.clock.advance(STOP_STEP);
    await stopping;
    expect(lines(st, "stop_late")[0].why).toBe(CLOSE_WHY);
    expect(lines(st, "stop")[0]).toMatchObject({ callsign: CS });
    expect(st.kernel.sessions.get(CS)!.rec.stopped).toBe(true);
  });

  it("предел перезапуска: строка restart_late дословно", async () => {
    // источник: слово пользователя 4 нояб. — ход законно идёт часами, перезапуск отменяется
    const st = await stand({ modules: [] });
    const site = await st.open(CS);
    st.proc(CS).send(msg.state("running"));
    await until(() => site.state === "busy");
    const restarting = site.restart();
    st.clock.advance(RESTART_WAIT);
    await restarting;
    expect(lines(st, "restart_late")[0]).toMatchObject({ kind: "refuse", callsign: CS, why: "ход не кончился за 6 ч — перезапуск отменён" });
    expect(st.sdk.of(CS)).toHaveLength(1);
  });

  it("остановка ОС: причина дословно; сбой процесса: код, сигнал и stderr дословно", async () => {
    // источник: устав «причина в журнале»; слова — чьё: код
    const st = await stand({ modules: [] });
    await st.open(CS);
    st.proc(CS).exit(0, "", null, true);
    await until(() => lines(st, "session_os_stop").length === 1);
    expect(lines(st, "session_os_stop")[0].why).toBe("остановка ОС: процесс claude вышел, код 0");
    await st.open("wiki@laptop");
    st.proc("wiki@laptop").exit(137, "нет памяти", "SIGKILL");
    await until(() => lines(st, "session_exited").length === 1);
    expect(lines(st, "session_exited")[0]).toMatchObject({ kind: "stop", callsign: "wiki@laptop", why: "процесс claude вышел, код 137, сигнал SIGKILL: нет памяти" });
  });

  it("строки старта и связи: launch, open, remove, ready, hello; relay_closed с причиной", async () => {
    // источник: устав «агент заметит это по журналу»; поля — чьё: код
    const st = await stand({ modules: [] });
    const s = await st.open(CS, { cwd: st.home });
    await until(() => lines(st, "hello").length === 1);
    expect(lines(st, "hello")[0].why).toBe("hello принят");
    expect(lines(st, "open")[0]).toMatchObject({ callsign: CS, cwd: st.home });
    expect(lines(st, "launch")[0]).toMatchObject({ callsign: CS, start: "spawn", sdk: "0.3.311", session_id: s.info.session_id });
    expect(lines(st, "ready")[0]).toMatchObject({ version: "1.4.0" });
    expect(lines(st, "host_start")[0]).toMatchObject({ version: "1.4.0", sdk: "0.3.311", modules: [] });
    await s.remove();
    expect(lines(st, "remove")[0]).toMatchObject({ callsign: CS });
    expect(st.relay.frames("session.state").at(-1)).toMatchObject({ callsign: CS, state: null });
    st.relay.drop(1006, "обрыв");
    await until(() => lines(st, "relay_closed").length === 1);
    expect(lines(st, "relay_closed")[0].why).toBe("обрыв");
  });

  it("relay закрыл навсегда: строка relay_stopped; пропуск не принят — остановка с причиной и выход 0", async () => {
    // источник: устав — часть машины умерла: чистый перезапуск; слова — чьё: код
    const st = await stand({ modules: [] });
    st.relay.conns.at(-1)!.drop(1008, "revoked");
    await until(() => st.exits.length === 1);
    expect(st.exits).toEqual([0]);
    expect(lines(st, "relay_stopped")[0]).toMatchObject({ kind: "stop", word: "revoked", why: "relay закрыл соединение: revoked — Host не переподключается" });
    expect(lines(st, "shutdown")[0].why).toBe("остановка: relay не принял пропуск машины: revoked");
    expect(lines(st, "exit")[0].why).toBe("выход 0 · relay не принял пропуск машины: revoked");
  });

  it("решения без владельца: deny и строка refuse дословно; форма без владельца — decline и строка", async () => {
    // источник: устав «AskUserQuestion не решается автоматически»; слова — чьё: код
    const st = await stand({ modules: [] });
    await st.open(CS);
    const p = st.proc(CS);
    expect(await p.ask("Bash", { command: "ls" })).toEqual({ behavior: "deny", message: "unknown_request" });
    expect(lines(st, "decide")[0]).toMatchObject({ kind: "refuse", word: "unknown_request", callsign: CS, tool: "Bash", why: "Bash: у решения нет владельца — ответ за человека не выбран" });
    expect(await p.elicit({ serverName: "x", message: "m" })).toEqual({ action: "decline" });
    expect(lines(st, "elicit")[0]).toMatchObject({ callsign: CS, why: "у форм MCP нет владельца — decline" });
  });

  it("общее решение decide.* — для инструмента без своего владельца; владелец упал — deny module_error и строка refuse", async () => {
    // источник: контракт decide; устав «ошибка модуля — модуль выключен»
    const seen: unknown[] = [];
    const st = await stand({ modules: [module("host-perm", { decide: { "*": (_s, _i, o) => (seen.push(o.tool), { behavior: "allow", updatedInput: {} }) } }), module("host-q", { decide: { AskUserQuestion: () => { throw new Error("упал"); } } })] });
    await st.open(CS);
    const p = st.proc(CS);
    expect(await p.ask("Bash", {})).toMatchObject({ behavior: "allow" });
    expect(seen).toEqual(["Bash"]);
    expect(await p.ask("AskUserQuestion", {})).toEqual({ behavior: "deny", message: "module_error" });
    expect(lines(st, "decide").at(-1)).toMatchObject({ kind: "refuse", word: "module_error", callsign: CS, module: "host-q", tool: "AskUserQuestion" });
    expect(lines(st, "module_failed").at(-1)!.why).toContain("host-q: decide.AskUserQuestion — ");
    expect(lines(st, "module_failed").at(-1)!.why).toContain("; модуль выключен в сессии");
  });

  it("запрос к выключенному модулю: строка refuse дословно, в сессии и на машине", async () => {
    // источник: устав «ошибка модуля — модуль выключен»; слова — чьё: код
    const st = await stand({ modules: [module("host-x", { requests: { "x.do": () => { throw new Error("упал"); } } })] });
    await st.open(CS);
    await st.relay.request({ type: "x.do", v: 1, callsign: CS });
    const r = await st.relay.request({ type: "x.do", v: 1, callsign: CS });
    expect(r).toMatchObject({ ok: false, error: "module_error" });
    expect(lines(st, "request").at(-1)).toMatchObject({ kind: "refuse", word: "module_error", module: "host-x", why: `x.do: модуль host-x выключен в ${CS}` });
    await st.relay.request({ type: "x.do", v: 1 });
    await st.relay.request({ type: "x.do", v: 1 });
    expect(lines(st, "request").at(-1)!.why).toBe("x.do: модуль host-x выключен");
  });

  it("кадр без владельца: строка дословно; папка не создана — отказ bad_dir со словами; записи нет", async () => {
    // источник: устав «ошибки — словами»; слова — чьё: код
    const st = await stand({ modules: [module("host-m", { requests: { "m.open": async (req, { host }) => (await host.open({ callsign: CS, cwd: req.cwd as string, mkdir: true })).info.callsign } })] });
    st.relay.deliver({ type: "nobody" } as never);
    await until(() => lines(st, "frame").length === 1);
    expect(lines(st, "frame")[0]).toMatchObject({ kind: "refuse", word: "unknown_request", why: "кадр nobody: владельца нет" });
    const file = join(st.home, "файл");
    writeFileSync(file, "x");
    const r = await st.relay.request({ type: "m.open", v: 1, cwd: join(file, "вложенная") });
    expect(r).toMatchObject({ ok: false, error: "bad_dir" });
    expect(String((r as { why?: string }).why)).toContain(`${CS}: папка ${join(file, "вложенная")} не создана — `);
    expect(st.kernel.sessions.has(CS)).toBe(false);
  });

  it("opening не вернулся за 12 с: модуль выключен, запрос открытия отказан словом", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; 3149 — тот же предел у start
    const st = await stand({ modules: [module("host-o", { opening: () => new Promise<void>(() => {}), openingReads: ["x"] })] });
    const opening = st.open(CS, { opening: { x: 1 } }).then(() => "ok", (e: { word?: string; why?: string }) => [e.word, e.why]);
    await until(() => true);
    await new Promise((r) => setTimeout(r, 20));
    st.clock.advance(12_000);
    expect(await opening).toEqual(["module_error", `host-o выключен: запрос открытия ${CS} не прочитан`]);
    expect(lines(st, "module_failed")[0].why).toContain("opening() не вернулся за 12 с");
  });

  it("отказ словом в session() сохранённой сессии: причина дословно", async () => {
    // источник: E35; слова — чьё: код
    const st = await stand({ sessions: [{ callsign: CS }], modules: [module("host-s", { session: () => { throw refuse("no_slot", "слота нет"); } })] });
    expect(lines(st, "module_failed")[0].why).toContain("отказ no_slot в session(): слота нет");
    expect(st.kernel.sessions.get(CS)!.state).toBe("idle");
  });

  it("опция ядра во вкладе: модуль выключен в сессии, причина называет опцию; каждая опция ядра", async () => {
    // источник: чьё: код — эти опции держит ядро, модулю их не взять
    for (const key of ["prompt", "cwd", "resume", "sessionId", "forkSession", "continue", "allowDangerouslySkipPermissions", "spawnClaudeCodeProcess", "canUseTool", "onElicitation", "systemPrompt", "abortController", "pathToClaudeCodeExecutable", "executable", "persistSession", "sessionStore"]) {
      const st = await stand({ modules: [module("host-p", { session: () => ({ [key]: 1 }) })] });
      await st.open(CS);
      expect(lines(st, "module_failed")[0].why).toContain(`опция ${key} — её держит ядро`);
      expect(st.query(CS).options.permissionMode).toBe("bypassPermissions");
    }
  });

  it("окружение процесса: DISABLE_UPDATES и события состояния — всегда; у пробы и команды claude — DISABLE_UPDATES", async () => {
    // источник: устав «в окружении сессий DISABLE_UPDATES=1»; чьё: код — состояние сессии только из session_state_changed
    const st = await stand({ modules: [module("host-e", { session: () => ({ env: { DISABLE_UPDATES: "0", MINE: "1" } }) }, { calls: ["getContextUsage"] })] });
    await st.open(CS);
    expect(st.query(CS).options.env).toMatchObject({ DISABLE_UPDATES: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1", MINE: "1" });
    const probe = st.host("host-e").probe({ env: { P: "2" } });
    expect(st.sdk.queries.at(-1)!.options.env).toMatchObject({ DISABLE_UPDATES: "1", P: "2" });
    expect(st.sdk.queries.at(-1)!.options).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, pathToClaudeCodeExecutable: "/opt/sdk/claude" });
    probe.close();
    await st.host("host-e").cli(["--version"], { env: { C: "3" }, input: "x" });
    expect(st.sdk.cliCalls.at(-1)).toMatchObject({ args: ["--version"], input: "x", env: { DISABLE_UPDATES: "1", C: "3" } });
  });

  it("соединение с Worker'ом: кадр к службе, Worker недоступен — строка не дошёл; список машин у gate — строка guest", async () => {
    // источник: устав «прямой запрос к Worker'у не прошёл — отказ словом»; чьё: код — строки журнала связи
    const relayStand = new FakeRelay();
    relayStand.workersDown = true;
    const st = await stand({ relayStand, modules: [module("host-l", {}, { uses: { "ledger.add@ledger": 1 } })] });
    expect(st.host("host-l").emit({ type: "ledger.add", to: ".ledger" }).ok).toBe(true);
    await until(() => lines(st, "ledger.add").length === 1);
    expect(lines(st, "ledger.add")[0]).toMatchObject({ kind: "note", why: expect.stringContaining("ledger.add → .ledger не дошёл: ") });
    await until(() => st.journal().some((l) => String(l.ev).startsWith("guest_")));
    expect(st.journal().find((l) => String(l.ev).startsWith("guest_"))!.why).toContain("keys.list");
  });
});

describe("история после сжатия", () => {
  let cfg: string;
  let dir: string;
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  const write = (records: unknown[]) => {
    const project = join(cfg, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${SID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };
  /** Весь разговор глазами модуля: сессия с этим разговором, настоящие функции SDK. */
  async function whole(o: Record<string, unknown> = {}): Promise<unknown> {
    const st = await standHost({ modules: [module("host-reader", {}, { calls: ["getSessionMessages"] })], sessions: [{ callsign: "site@laptop", session_id: SID, cwd: dir, stopped: true }] });
    st.sdk.functions = sdk as never;
    try {
      return await st.session("host-reader", "site@laptop")!.sdk("getSessionMessages", o);
    } finally {
      await st.close();
    }
  }
  const uuids = (m: unknown) => (m as Array<{ uuid: string }>).map((x) => x.uuid);

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "sb-history-"));
    dir = join(cfg, "proj");
    mkdirSync(dir);
    process.env.CLAUDE_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    rmSync(cfg, { recursive: true, force: true });
  });

  it("5531 · 32 сообщения до сжатия и 7 после: вернулись все — до этой склейки SDK отдавал только хвост", async () => {
    // источник: опыт на SDK 0.3.311 (32 + 7, вернулось 9), бэклог «История чата обрывается на последнем сжатии контекста»
    const before = chain("b", 32, null);
    const after = chain("c", 7, "s");
    write([...before, boundary("x", "b31"), summary("s", "x"), ...after]);
    const plain = uuids(await getSessionMessages(SID, { dir }));
    expect(plain.length).toBeLessThan(10);
    const all = uuids(await whole());
    expect(all).toEqual([...before.map((m) => m.uuid), "s", ...after.map((m) => m.uuid)]);
  });

  it("5532 · два сжатия: сообщения до, между и после обоих, по порядку", async () => {
    // источник: PR #1430 claude-agent-acp («for a session compacted twice…»), настоящий файл с двумя границами 3 нояб.
    const a = chain("a", 4, null);
    const b = chain("b", 4, "s1");
    const c = chain("c", 2, "s2");
    write([...a, boundary("x1", "a3"), summary("s1", "x1"), ...b, boundary("x2", "b3"), summary("s2", "x2"), ...c]);
    expect(uuids(await whole())).toEqual([...a.map((m) => m.uuid), "s1", ...b.map((m) => m.uuid), "s2", ...c.map((m) => m.uuid)]);
  });

  it("5533 · сжатие с сохранёнными сообщениями: они на своём месте и один раз, цепочка не зациклена", async () => {
    // источник: PR #1430 claude-agent-acp (сведения о сохранённых зацикливают цепочку)
    const a = chain("a", 6, null);
    const meta = { preservedSegment: { headUuid: "a4", anchorUuid: "s", tailUuid: "a5" }, preservedMessages: ["a4", "a5"] };
    write([...a, boundary("x", "a5", meta), summary("s", "x"), line("z", "s")]);
    expect(uuids(await whole())).toEqual([...a.map((m) => m.uuid), "s", "z"]);
  });

  it("5534 · ссылка границы ведёт в никуда — родитель: предыдущее сообщение файла; история не обрывается", async () => {
    // источник: настоящий файл 3 нояб. (1 из 6): logicalParentUuid нет среди записей
    const a = chain("a", 4, null);
    // запись субагента перед границей родителем не становится
    const side = { ...line("side", "a3"), isSidechain: true };
    write([...a, side, boundary("x", "нет-такой"), summary("s", "x"), line("z", "s")]);
    expect(uuids(await whole())).toEqual([...a.map((m) => m.uuid), "s", "z"]);
  });

  it("5536 · s.sdk модуля (session.history, points) — весь разговор: сессии с папкой и записи с границей уже со ссылкой", async () => {
    // источник: бэклог «Задевает session.history и points» — оба зовут s.sdk("getSessionMessages")
    const m = module("host-reader", {}, { calls: ["getSessionMessages"] });
    const st = await standHost({ modules: [m] });
    await st.open("site@laptop");
    const s = st.session("host-reader", "site@laptop")!;
    let seen: any;
    st.sdk.functions = {
      getSessionInfo: async () => ({}),
      importSessionToStore: async (_sid: string, store: any) => void (await store.append({}, [line("b1", null), boundary("x", "b1")])),
      getSessionMessages: async (sid: string, o: any) => ((seen = { sid, o, entries: await o.sessionStore.load() }), ["весь разговор"]),
    } as never;
    expect(await s.sdk("getSessionMessages", { includeSystemMessages: true })).toEqual(["весь разговор"]);
    expect(seen).toMatchObject({ sid: s.info.session_id, o: { dir: s.info.cwd, includeSystemMessages: true } });
    expect(seen.entries[1].parentUuid).toBe("b1");
    await st.close();
  });

  it("5535 · без сжатия — как у SDK; опции проходят; файла ещё нет — пустой разговор", async () => {
    // чьё: код — session.history и points зовут getSessionMessages с опциями; новая сессия до первого хода без файла
    expect(await whole()).toEqual([]);
    const a = chain("a", 5, null);
    write(a);
    expect(await whole()).toEqual(await getSessionMessages(SID, { dir }));
    expect(uuids(await whole({ limit: 2 }))).toEqual(["a0", "a1"]);
  });
});
