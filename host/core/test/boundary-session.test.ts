// Леса ядра, жизнь сессии: процесс claude у держателя — запуск, ввод, остановка, сбой, новый Host, запись roster, протокол держателя, история.
// Настоящее ядро на стенде: поддельные SDK, relay, держатели и часы. Источник свойства — в комментарии теста, без пометки — чьё: код.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionInfo, getSessionMessages, importSessionToStore } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refuse } from "../contract.ts";
import type { Module } from "../contract.ts";
import { FakeQuery, FakeRelay, msg, module, standHost, turn, until } from "../stand/index.ts";
import type { FakeHolders, Stand } from "../stand/index.ts";
import { CS, RESTART_WAIT, STOP_STEP, core, keeper, lines, procs, stand, stands } from "./kit.ts";

describe("новая сессия", () => {
  it("host.open: spawn держателя, initialize, idle; запись в core.json; on.open видит spawn; hello и session.state в relay", async () => {
    const seen: string[] = [];
    const opened: string[] = [];
    const watch: Module = { on: { event: (_s, m) => void seen.push(m.type), open: (x) => void opened.push(x.info.start) } };
    const st = await stand({ modules: [module("host-watch", watch)] });
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

  it("system/init: модель и session_id — в s.info; новый session_id — в core.json", async () => {
    const st = await stand({ modules: [module("host-x", {})] });
    const s = await st.open("site@laptop");
    st.proc("site@laptop").send(msg.init("sid-2", "claude-opus-5"));
    await until(() => s.info.model === "claude-opus-5");
    expect(s.info.session_id).toBe("sid-2");
    const core = JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")) as { sessions: Array<{ session_id: string }> };
    expect(core.sessions[0].session_id).toBe("sid-2");
  });

  it("745 · query() сессии получает путь к claude, который нашёл Host: SDK не ищет его второй раз", async () => {
    // источник: факт 2 нояб. — открытие сессии на wsl ждало ~21 с: профиль CPU — 20 с в process.report.getReport() поиска claude в SDK
    const st = await stand();
    await st.open("site@laptop");
    expect(st.query("site@laptop").options.pathToClaudeCodeExecutable).toBe(st.sdk.bin);
    await st.close();
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

  it("папка не создана — отказ bad_dir со словами; записи нет", async () => {
    // источник: устав «ошибки — словами»; слово — чьё: код
    const st = await stand({ modules: [module("host-m", { requests: { "m.open": async (req, { host }) => (await host.open({ callsign: CS, cwd: req.cwd as string, mkdir: true })).info.callsign } })] });
    const file = join(st.home, "файл");
    writeFileSync(file, "x");
    const r = await st.relay.request({ type: "m.open", v: 1, cwd: join(file, "вложенная") });
    expect(r).toMatchObject({ ok: false, error: "bad_dir" });
    expect(String((r as { why?: string }).why)).toContain(join(file, "вложенная"));
    expect(st.kernel.sessions.has(CS)).toBe(false);
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

  it("разговор лежит в папке другого проекта: старт из точки и открытие с resume берут его, а не начинают новый", async () => {
    // источник: опыт на настоящем claude и SDK 6 нояб.: --resume находит разговор и в папке другого проекта, getSessionInfo с dir его там не видит, без dir — видит;
    // откат в окне точки: файл ложится в выбранную папку, прежняя копия уходит в сторону, сессия поднимается в своей папке
    const st = await stand({ modules: [] });
    const site = await st.open(CS);
    const sid = site.info.session_id;
    await site.stop();
    const fns = st.sdk.functions;
    st.sdk.functions = new Proxy(fns, { get: (real, name: string) => (name === "getSessionInfo" ? async (_id: string, o?: { dir?: string }) => (o?.dir ? undefined : {}) : real[name]) });
    await site.start({ point: 7 });
    expect(st.query(CS).options).toMatchObject({ resume: sid });
    expect(st.query(CS).options.sessionId).toBeUndefined();
    await st.kernel.open({ callsign: "other@laptop", cwd: st.home, resume: "orig-0001" });
    expect(st.query("other@laptop").options.resume).toBe("orig-0001");
  });

  it("запись ядра в core.json: поля и форк — формат заморожен: его читает следующий Host", async () => {
    // источник: устав «начинает с хранилища»; формат — живые данные на машинах; чьё: код
    const st = await stand({ modules: [] });
    const a = await st.open("a@laptop", { cwd: st.home });
    a.input("x", { from: "phone~u@e" });
    st.proc("a@laptop").send(msg.state("running"));
    await until(() => a.state === "busy");
    const fork = await st.kernel.open({ callsign: "fork@laptop", cwd: st.home, resume: "orig", fork: true });
    await st.kernel.open({ callsign: "pt@laptop", cwd: st.home, resume: "ptid", point: 5 });
    expect(core(st)).toEqual([
      { callsign: "a@laptop", cwd: st.home, session_id: a.info.session_id, sdk: "0.3.311", stopped: false, state: "busy", from: "phone~u@e" },
      { callsign: "fork@laptop", cwd: st.home, session_id: fork.rec.session_id, sdk: "0.3.311", stopped: false, fork: "orig", state: "idle" },
      { callsign: "pt@laptop", cwd: st.home, session_id: "ptid", sdk: "0.3.311", stopped: false, state: "idle" },
    ]);
    expect(lines(st, "launch").map((l) => l.start)).toEqual(["spawn", "fork", "point"]);
    expect(fork.startKind).toBe("resume");
  });
});

describe("стенд", () => {
  it("open, который ждёт то, чего стенд не даёт, — отказ словом по настоящим часам, а не висение до testTimeout (identity 10 нояб.: модуль ждал gate в session(), прогон висел больше 2 ч)", async () => {
    const st = await stand({ modules: [module("host-wait", { session: () => new Promise<never>(() => {}) })] });
    const from = Date.now();
    await expect(st.open(CS)).rejects.toThrow(/^стенд: open .+ не кончился за 5 с по настоящим часам/);
    expect(Date.now() - from).toBeLessThan(10_000);
  });
});

describe("остановка и перезапуск", () => {
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

  it("7351 · процесс не вышел после закрытия ввода: за предел убит, stop и restart доходят до конца, причина в журнале", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»
    for (const go of ["restart", "stop"] as const) {
      const st = await stand({ modules: [] });
      const site = await st.open(CS);
      st.proc(CS).noClose = true;
      const going = site[go]();
      await until(() => st.holders.ops.some((o) => o.op === "close_input"));
      st.clock.advance(STOP_STEP);
      await going;
      expect(st.holders.ops.filter((o) => o.op === "kill")).toHaveLength(1);
      expect(lines(st, "stop_late")[0].why).toContain("kill");
      expect(st.sdk.of(CS)).toHaveLength(go === "restart" ? 2 : 1);
    }
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
});

describe("сбой процесса", () => {
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

  it("719 · первый сбой до готовности при open, s.start и s.restart — отказ словами и один resume; второй выход — failed с обеими причинами, запись осталась", async () => {
    // источник: устав «процесс claude умер — один resume, второй сбой до готовности — failed»; контракт Session.start и restart
    const ways: Array<(st: Stand) => Promise<unknown>> = [
      async (st) => {
        st.holders.failInitNext = 2;
        return st.open(CS);
      },
      async (st) => {
        const s = await st.open(CS);
        await s.stop();
        st.holders.failInitNext = 2;
        return s.start();
      },
      async (st) => {
        const s = await st.open(CS);
        st.holders.failInitNext = 2;
        return s.restart();
      },
    ];
    for (const way of ways) {
      const st = await stand({ modules: [] });
      const refused = way(st);
      const silent = () => st.holders.procs.get(CS)?.failInit && st.holders.procs.get(CS)?.initializes === 1;
      await until(silent);
      st.proc(CS).exit(1, "первый");
      await expect(refused).rejects.toThrow("процесс вышел до initialize");
      await until(silent);
      st.proc(CS).exit(1, "второй");
      await until(() => st.kernel.sessions.get(CS)!.state === "failed");
      await new Promise((r) => setTimeout(r, 30));
      expect(lines(st, "session_failed")).toHaveLength(1);
      expect(lines(st, "session_failed")[0].why).toContain("первый");
      expect(lines(st, "session_failed")[0].why).toContain("второй");
      expect([...st.kernel.sessions.keys()]).toEqual([CS]);
    }
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

  it("initialize отказан, процесс жив — kill; дальше ветка «умер»: отказ открытия с причиной, один resume", async () => {
    // источник: устав «процесс claude умер — один resume», слово пользователя 2 нояб. «у всех операций должен быть лимит»;
    // опыт: claude отвечает на негодный initialize отказом и ждёт следующего запроса (в файле claude: lt(q,"initialize: …");continue), сам не выходит
    const st = await stand({ modules: [] });
    const query = st.sdk.query;
    let refused = 1;
    st.sdk.query = ((p: never) => {
      const q = query(p) as unknown as { initializationResult(): Promise<unknown> };
      if (refused-- > 0) q.initializationResult = () => Promise.reject(new Error("initialize: отказ"));
      return q as never;
    }) as never;
    await expect(st.open(CS)).rejects.toThrow("процесс вышел до initialize");
    expect(st.holders.ops.filter((o) => o.op === "kill")).toHaveLength(1);
    await until(() => st.kernel.sessions.get(CS)!.state === "idle");
    expect(st.sdk.of(CS)).toHaveLength(2);
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

describe("остановка ОС", () => {
  it("5525 · выход с os_stop — остановка ОС, не сбой: вывод дочитан, resume нет, причина в журнале, в записи не остановлена; s.start поднимает тем же разговором", async () => {
    // источник: слепое расширение плана keeper-holder 3 нояб.; чьё: код — keeper.go exitedPart: «такой выход — не падение, перезапуска нет»; hold.go ставит os_stop при любом коде и отдаёт выход после всего вывода
    for (const [code, signal, why] of [[0, null, "код 0"], [null, "SIGTERM", "сигнал SIGTERM"]] as const) {
      const closed: string[] = [];
      const seen: string[] = [];
      const st = await stand({ modules: [module("host-watch", { on: { close: (s) => void closed.push(s.info.callsign), event: (_s, m) => void seen.push(m.type) } })] });
      const site = await st.open(CS);
      const sid = site.info.session_id;
      const p = st.proc(CS);
      p.send(msg.state("running"));
      await until(() => site.state === "busy");
      p.send(msg.result());
      p.exit(code, "", signal, true);
      await until(() => site.state === "stopped" && seen.includes("result"));
      expect(st.sdk.of(CS)).toHaveLength(1);
      expect(lines(st, "session_exited")).toHaveLength(0);
      expect(lines(st, "session_failed")).toHaveLength(0);
      expect(lines(st, "session_os_stop")[0].why).toContain("остановка ОС");
      expect(lines(st, "session_os_stop")[0].why).toContain(why);
      expect(closed).toEqual([CS]);
      expect(core(st)[0].stopped).toBe(false);
      await site.start();
      await until(() => site.state === "idle");
      expect(st.query(CS).options.resume).toBe(sid);
    }
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
});

describe("новый Host и прежние сессии", () => {
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

  describe("новая сборка и живой процесс", () => {
    /** Встроенный сервер: как у настоящего Claude, новый список виден только после уведомления. */
    const server = (name: string, tools: string[], seen: { list: string[] }) => ({ type: "sdk", name, instance: { sendToolListChanged: vi.fn(async () => void (seen.list = tools)) } }) as never;

    it("7358 · подключение к живому процессу: набор серверов как в сборке, новый список инструментов, тот же процесс, ввод открыт после этого", async () => {
      // источник: слово пользователя 6 нояб. — сессия после перезагрузки Host остаётся со старым MCP; факт опыта на настоящем Claude
      const k = keeper();
      const a = await k.addProcess("a@laptop");
      const seen = { list: ["old_tool"] };
      const servers = { sb: server("sb", ["new_tool"], seen) };
      const st = await stand({ holders: k, sessions: [{ callsign: "a@laptop", state: "idle" }], modules: [module("host-a", { session: () => ({ mcpServers: servers }) })] });
      expect(seen.list).toEqual(["new_tool"]);
      expect(st.query("a@laptop").calls.filter((c) => c.name === "setMcpServers").map((c) => c.args[0])).toEqual([servers]);
      expect(k.ops.filter((o) => o.id === "a@laptop").map((o) => o.op)).toEqual(["attach"]);
      expect(a.alive).toBe(true);
      expect(st.kernel.sessions.get("a@laptop")!.state).toBe("idle");
    });

    it("7359 · новый процесс: шага нет, он сам читает инструменты при старте", async () => {
      // источник: факт опыта — новый процесс спрашивает список сам
      const seen = { list: ["old_tool"] };
      const st = await stand({ modules: [module("host-a", { session: () => ({ mcpServers: { sb: server("sb", ["new_tool"], seen) } }) })] });
      await st.open("site@laptop");
      expect(st.query("site@laptop").calls.filter((c) => c.name === "setMcpServers")).toEqual([]);
      expect(seen.list).toEqual(["old_tool"]);
    });

    it("7360 · другая версия SDK у живого процесса: шага нет, сессия перезапускается", async () => {
      // источник: чьё: код — смена версии SDK перезапускает сессию в конце хода
      const k = keeper();
      await k.addProcess("a@laptop");
      const st = await stand({ holders: k, sessions: [{ callsign: "a@laptop", sdk: "0.0.1" }], modules: [] });
      await until(() => st.sdk.of("a@laptop").length === 2);
      expect(st.sdk.of("a@laptop")[0].calls.filter((c) => c.name === "setMcpServers")).toEqual([]);
    });

    it("7361 · Claude отказал в обновлении: строка журнала с причиной, сессия работает", async () => {
      // источник: 🔒 устава «система ловит, агент чинит»; у всех операций лимит
      const k = keeper();
      await k.addProcess("a@laptop");
      const set = vi.spyOn(FakeQuery.prototype, "setMcpServers").mockRejectedValueOnce(new Error("сервер отвалился"));
      const st = await stand({ holders: k, sessions: [{ callsign: "a@laptop" }], modules: [] });
      set.mockRestore();
      expect(lines(st, "fit")[0]).toMatchObject({ kind: "stop", callsign: "a@laptop", why: "инструменты модулей не обновлены: сервер отвалился" });
      expect(st.kernel.sessions.get("a@laptop")!.state).toBe("idle");
    });

    it("7362 · Claude молчит: за 30 с строка журнала, сессия работает, старт Host не встал", async () => {
      // источник: 🔒 устава «у всех операций должен быть лимит»
      const k = keeper();
      await k.addProcess("a@laptop");
      const set = vi.spyOn(FakeQuery.prototype, "setMcpServers").mockReturnValueOnce(new Promise(() => {}));
      const st = await stand({ holders: k, sessions: [{ callsign: "a@laptop" }], modules: [], start: false });
      const started = st.start();
      await until(() => set.mock.calls.length === 1);
      set.mockRestore();
      st.clock.advance(STOP_STEP - 1);
      expect(lines(st, "fit")).toEqual([]);
      st.clock.advance(1);
      await started;
      expect(lines(st, "fit")[0].why).toBe("инструменты модулей не обновлены: нет ответа за 30 с");
      expect(st.kernel.sessions.get("a@laptop")!.state).toBe("idle");
    });
  });

  it("701 · сессии прежнего Host: живая — attach с состоянием записи; нет держателя — resume, и failed тоже; остановленная — stopped без процесса", async () => {
    // источник: устав «keeper умер или подменил себя — ОС поднимает его, держатели живут»; «процесс claude умер — один resume»; чистый перезапуск начинает с хранилища; остановленная без процесса — чьё: код
    const k = keeper();
    const a = await k.addProcess("a@laptop");
    const st = await stand({
      holders: k,
      sessions: [{ callsign: "a@laptop", state: "busy" }, { callsign: "b@laptop" }, { callsign: "c@laptop", stopped: true }, { callsign: "d@laptop", state: "failed" }],
      modules: [],
    });
    expect(k.ops.filter((o) => o.id === "a@laptop").map((o) => o.op)).toEqual(["attach"]);
    expect(a.initializes).toBe(1);
    expect(st.kernel.sessions.get("a@laptop")!.state).toBe("busy");
    expect(k.spawns.map((s) => s.id)).toEqual(["b@laptop", "d@laptop"]);
    for (const cs of ["b@laptop", "d@laptop"]) {
      expect(st.query(cs).options.resume).toBe("sid-" + cs[0]);
      expect(st.kernel.sessions.get(cs)!.state).toBe("idle");
    }
    expect(st.kernel.sessions.get("c@laptop")!.state).toBe("stopped");
    expect(st.sdk.of("c@laptop")).toHaveLength(0);
    expect(lines(st, "ready")).toHaveLength(1);
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

describe("ввод", () => {
  it("s.input: сообщения user в очередь ввода — до процесса доходят по порядку с priority, uuid и origin", async () => {
    const st = await stand({ modules: [module("host-chat", {})] });
    const s = await st.open("site@laptop");
    const uuid = "00000000-0000-4000-8000-0000000000aa";
    s.input("Собери отчёт");
    s.input("Срочно", { priority: "now", uuid, origin: { kind: "x" } });
    const p = st.proc("site@laptop");
    await until(() => p.inputs.length === 2);
    expect(p.inputs[0]).toMatchObject({ type: "user", message: { role: "user", content: "Собери отчёт" } });
    expect(p.inputs[1]).toMatchObject({ type: "user", priority: "now", uuid, origin: { kind: "x" }, message: { role: "user", content: "Срочно" } });
  });

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

  it("ввод между смертью процесса и новым query() не теряется: настоящий SDK забирает его из потока и никуда не пишет", async () => {
    // источник: контракт Session.input «Очередь живёт в ядре и переживает resume»; опыт на SDK 0.3.311: после смерти процесса в очереди 0, в stdin не дошло
    let release = () => {};
    let slow = false;
    const m = module("host-slow", { session: () => (slow ? new Promise<undefined>((r) => (release = () => r(undefined))) : undefined) });
    const st = await stand({ modules: [m] });
    const s = await st.open(CS);
    const first = st.proc(CS);
    slow = true;
    first.exit(1, "упал");
    await until(() => lines(st, "session_exited").length === 1);
    s.input("пока поднимается");
    await new Promise((r) => setTimeout(r, 30));
    release();
    await until(() => st.sdk.of(CS).length === 2 && st.kernel.sessions.get(CS)!.state === "idle");
    const second = st.proc(CS);
    await until(() => second.inputs.length === 1);
    expect(second.inputs[0].message.content).toBe("пока поднимается");
  });


  it("ввод, пока stop закрывает процесс, ждёт следующего старта", async () => {
    // источник: контракт Session.input; спорное место первого круга — поток ушедшего процесса отставлен сразу
    const st = await stand({ modules: [] });
    const s = await st.open(CS);
    const first = st.proc(CS);
    first.noClose = true;
    const stopping = s.stop();
    await until(() => st.holders.ops.some((o) => o.op === "close_input"));
    s.input("пока закрывается");
    await new Promise((r) => setTimeout(r, 20));
    st.clock.advance(STOP_STEP);
    await stopping;
    expect(first.inputs).toEqual([]);
    await s.start();
    await until(() => st.proc(CS).inputs.length === 1);
    expect(st.proc(CS).inputs[0].message.content).toBe("пока закрывается");
  });

  it("ввод остановленной сессии ждёт: дошёл после s.start; повторный stop ничего не делает", async () => {
    // источник: контракт Session.input «Очередь живёт в ядре и переживает resume»
    const st = await stand({ modules: [] });
    const s = await st.open(CS);
    await s.stop();
    s.input("после стопа");
    await s.start();
    await until(() => st.proc(CS).inputs.length === 1);
    expect(st.proc(CS).inputs[0].message.content).toBe("после стопа");
    expect(st.proc(CS).inputs[0].parent_tool_use_id).toBeNull();
    await s.stop();
    await s.stop();
    expect(lines(st, "stop").length).toBeGreaterThanOrEqual(2);
    expect(s.state).toBe("stopped");
  });

  it("314 · отправитель последнего ввода — в записи ядра на диске, ввод без from его не меняет; переживает перезапуск Host", async () => {
    // источник: принятый дизайн «Host · отправитель» — отправитель последнего ввода в записи сессии на диске; ввод без from — чьё: код
    const holders = keeper();
    const st = await stand({ machine: "win", holders, modules: [module("host-reader", {})] });
    const s = await st.open("disk-full-1@win");
    s.input("Свободно 2%", { from: "phone~owner@example.com" });
    s.input("Продолжай");
    expect(s.info.from).toBe("phone~owner@example.com");
    expect(core(st).find((x) => x.callsign === "disk-full-1@win")!.from).toBe("phone~owner@example.com");
    await st.close();
    const st2 = await stand({ machine: "win", home: st.home, holders, modules: [module("host-reader", {})] });
    await until(() => st2.session("host-reader", "disk-full-1@win")?.state === "idle");
    expect(st2.session("host-reader", "disk-full-1@win")!.info.from).toBe("phone~owner@example.com");
  });
});

describe("состояние и запись roster", () => {
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

  it("запись roster: callsign, state, sdk, dir, by, failed и поля модулей", async () => {
    // источник: устав «Roster — из attachments живых соединений»; порядок ключей — чьё: код
    const st = await stand({ modules: [module("host-t", { fields: { tag: () => "t" }, on: { event: () => { throw new Error("бах"); } } })] });
    const s = await st.open(CS, { cwd: st.home });
    s.input("x", { from: "phone~u@e" });
    st.proc(CS).send(msg.assistant("a"));
    await until(() => st.states(CS).at(-1)?.failed);
    expect(Object.keys(st.states(CS).at(-1)!).sort()).toEqual(["by", "callsign", "dir", "failed", "sdk", "state", "type"]);
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

  it("ничей держатель молчит на kill: старт Host не висит, за предел — строка и дальше", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; опыт: старт ждал без конца
    const server = net.createServer((c) => c.on("error", () => {}));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const file = { id: "old@laptop", owner: "host", pid: 4242, port, key: "key" };
    const holders = { spawn: async () => { throw new Error("нельзя"); }, files: () => [file], close: async () => {} } as unknown as FakeHolders;
    const st = await stand({ holders, start: false });
    stands.push(st);
    const starting = st.start();
    await until(() => lines(st, "orphan_kill").length === 1);
    await new Promise((r) => setTimeout(r, 30));
    st.clock.advance(STOP_STEP);
    await starting;
    expect(lines(st, "orphan_late")[0]).toMatchObject({ kind: "stop", callsign: "old@laptop", why: "держатель old@laptop не вышел за 30 с после kill — старт идёт дальше" });
    expect(lines(st, "ready")).toHaveLength(1);
    server.close();
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

describe("история после сжатия", () => {
  let root: string;
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
    const st = await stand({ home: root, modules: [module("host-reader", {}, { calls: ["getSessionMessages"] })], sessions: [{ callsign: "site@laptop", session_id: SID, cwd: dir, stopped: true }] });
    st.sdk.functions = sdk as never;
    try {
      return await st.session("host-reader", "site@laptop")!.sdk("getSessionMessages", o);
    } finally {
      await st.close();
    }
  }
  const uuids = (m: unknown) => (m as Array<{ uuid: string }>).map((x) => x.uuid);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sb-history-"));
    cfg = join(root, "claude");
    dir = join(root, "proj");
    mkdirSync(dir);
  });
  afterEach(() => {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    rmSync(root, { recursive: true, force: true });
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
    const st = await stand({ modules: [m] });
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

describe("сверка круга 3: правила из строк старого кода", () => {
  it("restart, пока процесс поднимается после сбоя: второго запуска нет", async () => {
    // источник: контракт Session.restart; чьё: код — поднимается уже: запускать нечего
    let release = () => {};
    let slow = false;
    const st = await stand({ modules: [module("host-slow", { session: () => (slow ? new Promise<undefined>((r) => (release = () => r(undefined))) : undefined) })] });
    const s = await st.open(CS);
    slow = true;
    st.proc(CS).exit(1, "упал");
    await until(() => s.state === "starting");
    await s.restart();
    release();
    await until(() => s.state === "idle");
    expect(st.sdk.of(CS)).toHaveLength(2);
  });

  it("проверка файла разговора молчит: за ступень запуск идёт дальше resume", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»
    const st = await stand({ modules: [] });
    const s = await st.open(CS);
    await s.stop();
    st.sdk.functions = { getSessionInfo: () => new Promise(() => {}) } as never;
    const starting = s.start();
    await new Promise((r) => setTimeout(r, 20));
    st.clock.advance(STOP_STEP);
    await starting;
    expect(st.query(CS).options.resume).toBe(s.info.session_id);
  });
});

describe("раунд lost: сверка со старым кодом", () => {
  it("запрос с адресом сессии в to — о ней: ошибка выключает модуль в этой сессии, отказ module_error только ей", async () => {
    // источник: устав «Ошибку модуля ловит ядро: модуль выключается в этой сессии»; путь — message между сессиями: адрес в to, callsign нет
    let broken = true;
    const seen: string[] = [];
    const peer = module("host-peer", {
      requests: {
        poke: (f) => {
          if (broken) throw new Error("сломан");
          seen.push(String(f.to));
        },
      },
    });
    const st = await stand({ modules: [peer] });
    await st.open("a@laptop");
    await st.open("b@laptop");
    expect(await st.relay.request({ type: "poke", v: 1, to: "a@laptop" })).toMatchObject({ ok: false, error: "module_error" });
    expect(lines(st, "module_failed")[0]).toMatchObject({ module: "host-peer", callsign: "a@laptop" });
    await until(() => st.states("a@laptop").at(-1)?.failed?.["host-peer"]);
    broken = false;
    expect(await st.relay.request({ type: "poke", v: 1, to: "a@laptop" })).toMatchObject({ ok: false, error: "module_error" });
    expect(await st.relay.request({ type: "poke", v: 1, to: "b@laptop" })).toMatchObject({ ok: true });
    expect(seen).toEqual(["b@laptop"]);
    expect(st.states("b@laptop").at(-1)?.failed).toBeUndefined();
  });

  it("query() бросил — нет файла claude в пакете SDK: отказ словами, ветка сбоя: один resume, второй — failed; stop и start работают", async () => {
    // источник: устав «процесс claude умер — один resume, второй сбой до готовности — failed»; факт: SDK 0.3.311 бросает из query(), если pathToClaudeCodeExecutable нет и пакет платформы не найден
    const st = await stand({ modules: [] });
    const query = st.sdk.query;
    st.sdk.query = (() => {
      throw new Error("Native CLI binary for win32-x64 not found");
    }) as never;
    await expect(st.open(CS)).rejects.toThrow("Native CLI binary for win32-x64 not found");
    const s = st.kernel.sessions.get(CS)!;
    await until(() => s.state === "failed");
    expect(lines(st, "session_exited")).toHaveLength(2);
    expect(lines(st, "session_failed")[0].why).toContain("Native CLI binary");
    await s.stop();
    expect(s.state).toBe("stopped");
    st.sdk.query = query;
    await s.start();
    expect(s.state).toBe("idle");
  });

  it("query() бросил на старте Host: сессия failed, Host всё равно ready", async () => {
    // источник: устав «второй сбой до готовности — failed»; факт тот же: одна сессия не держит старт машины
    const st = await stand({ modules: [], sessions: [{ callsign: CS }], start: false });
    st.sdk.query = (() => {
      throw new Error("Native CLI binary for win32-x64 not found");
    }) as never;
    await st.start();
    expect(st.kernel.sessions.get(CS)!.state).toBe("failed");
    expect(lines(st, "ready")).toHaveLength(1);
  });

  it("первый сбой до готовности: в отказе — причина выхода, а не только факт", async () => {
    // источник: устав «ошибки — словами»; отказ идёт клиенту как open_failed, журнала он не видит; чьё: код — «процесс вышел до initialize — причина»
    const st = await stand({ modules: [] });
    st.holders.failInitNext = 1;
    const opening = st.open(CS);
    await until(() => st.holders.procs.get(CS)?.initializes === 1);
    st.proc(CS).exit(1, "Invalid API key");
    await expect(opening).rejects.toThrow("Invalid API key");
  });

  it("отказ в журнале: кто и какой запрос; причина есть и у отказа без слов", async () => {
    // источник: устав «отвечаешь по фактам из журнала», принцип «ошибка словом, причина в журнале»; чьё: код — id, from и why у строки refuse
    const no = module("host-no", {
      requests: {
        "no.x": () => {
          throw refuse("nope");
        },
      },
    });
    const st = await stand({ modules: [no] });
    expect(await st.relay.request({ id: "r1", type: "no.x", v: 1 })).toMatchObject({ ok: false, error: "nope" });
    expect(await st.relay.request({ id: "r2", type: "absent.x", v: 1 })).toMatchObject({ ok: false, error: "unknown_request" });
    const from = "panel-desk~owner@example.com";
    expect(lines(st, "request").find((l) => l.word === "nope")).toMatchObject({ id: "r1", from, why: "no.x: nope", who: "host-no" });
    expect(lines(st, "request").find((l) => l.word === "unknown_request")).toMatchObject({ id: "r2", from });
  });
});
