// План тестов v2, ядро Host: ожидаемые ветки запуска, сбоя процесса, обрыва связи и остановки, которых не держал ни один тест.
// Источник свойств — закрытый список веток восстановления и «система ловит» из устава; «чьё: код» помечено у теста.
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionStop } from "@sb/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { Module } from "../src/core/contract.ts";
import { FakeHolders, stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const PULT = "pult~yuri@example.com";
const CS = "site@laptop";
const logged = (msg: string) => st!.journal().filter((l) => l.msg === msg);

describe("план v2: запуск Host", () => {
  // устав: «После перезапуска Host модуль поднимает своё из хранилища»
  it("держателей нет: живая сессия поднята resume тем же разговором, остановленная остаётся остановленной", async () => {
    st = await stand({ sessions: [{ callsign: CS }, { callsign: "old@laptop", stopped: true }] });
    const site = st.kernel.sessions.get(CS)!;
    await until(() => site.state === "idle", 5000, "site idle");
    expect((st.sdk.last(CS)!.options as any).resume).toBe("sid-" + CS);
    expect(st.holders.spawns.map((s) => s.id)).toEqual([CS]);
    expect(st.kernel.sessions.get("old@laptop")!.state).toBe("stopped");
    expect(logged("ready")).toHaveLength(1);
  });

  // чьё: код — новый SDK вступает в силу перезапуском процесса на том же разговоре
  it("версия SDK сменилась: процесс подхвачен, затем перезапущен на том же разговоре; в записи — новая версия", async () => {
    const holders = new FakeHolders();
    const first = await stand({ holders, sdkVersion: "0.3.320" });
    const { s } = await first.open("site");
    const sid = s.rec.sessionId;
    await first.kernel.shutdown("подмена");
    st = await stand({ holders, home: first.home, sdkVersion: "0.3.321" });
    const again = st.kernel.sessions.get(CS)!;
    await until(() => holders.spawns.length === 2 && again.state === "idle" && again.rec.sdk === "0.3.321", 5000, "перезапуск на новом SDK");
    expect(holders.ops.filter((o) => o.op === "attach").length).toBeGreaterThan(0);
    expect((st.sdk.last(CS)!.options as any).resume).toBe(sid);
  });

  // устав: «система ловит» — останавливает и пишет в журнал с причиной
  it("процесс у держателя без сессии убит, в журнале orphan_kill с позывным", async () => {
    const holders = new FakeHolders();
    const ghost = await holders.addProcess("ghost@laptop");
    st = await stand({ holders });
    expect(ghost.alive).toBe(false);
    expect(logged("orphan_kill")[0]).toMatchObject({ callsign: "ghost@laptop" });
    expect(String(logged("orphan_kill")[0]!.why)).toContain(String(ghost.pid));
  });

  it("start модуля бросил — Host не стартует: check_failed с именем модуля, соединения с флотом нет", async () => {
    const bad: Module = { name: "bad", start() { throw new Error("порт занят"); } };
    st = await stand({ modules: [bad] });
    expect(st.error).toBeDefined();
    expect(st.journal().filter((l) => l.word === "check_failed").some((l) => String(l.why).includes("bad") && String(l.why).includes("порт занят"))).toBe(true);
    expect(st.link.state).toBe("closed");
  });

  it("вклад модуля в запуск одной сессии бросил — она failed с именем модуля в строке, вторая поднята", async () => {
    const picky: Module = { name: "picky", compose(s) { if (s.callsign === "a@laptop") throw new Error("нет набора"); return {}; } };
    st = await stand({ modules: [picky], sessions: [{ callsign: "a@laptop" }, { callsign: "b@laptop" }] });
    const a = st.kernel.sessions.get("a@laptop")!, b = st.kernel.sessions.get("b@laptop")!;
    await until(() => a.state === "failed" && b.state === "idle", 5000, "a failed, b idle");
    expect(st.link.rows("a@laptop").at(-1)!.row).toMatchObject({ state: "failed", error: expect.stringContaining("picky") });
    expect(logged("session_failed").some((l) => l.callsign === "a@laptop")).toBe(true);
  });
});

describe("план v2: процесс сессии", () => {
  // устав: «у всех операций должен быть лимит»; закрытый список: «процесс claude умер — один resume»
  it("процесс молчит на initialize: kill за предел, в журнале initialize_late, дальше один resume", async () => {
    st = await stand();
    st.holders.failInitNext = 1;
    const opening = st.request("session.open", { to: "@laptop", spec: { name: "site", cwd: st.dir } }, PULT);
    await until(() => st!.holders.procs.get(CS)?.failInit && st!.holders.procs.get(CS)!.initializes === 1, 5000, "молчащий процесс");
    st.clock.advance(60_000);
    expect(await opening).toMatchObject({ ok: false, error: "open_failed" });
    expect(logged("initialize_late")[0]).toMatchObject({ callsign: CS });
    expect(st.holders.ops.some((o) => o.op === "kill" && o.id === CS)).toBe(true);
    const s = st.kernel.sessions.get(CS)!;
    await until(() => st!.holders.spawns.length === 2 && s.state === "idle", 5000, "resume");
  });

  // чьё: код — вторая попытка ничего не даст, причина прямо в строке
  it("папки сессии больше нет — failed сразу с причиной в строке, resume не было", async () => {
    st = await stand();
    const cwd = join(st.dir, "gone");
    mkdirSync(cwd);
    const { s, proc } = await st.open("site", { cwd });
    rmSync(cwd, { recursive: true });
    proc.exit(1, "spawn claude ENOENT: no such file or directory");
    await until(() => s.state === "failed", 5000, "failed");
    expect(st.link.rows(CS).at(-1)!.row).toMatchObject({ state: "failed", error: expect.stringContaining("папки сессии нет") });
    expect(st.holders.spawns).toHaveLength(1);
  });

  // чьё: код — машина выключается: это не сбой процесса
  it("процесс остановила ОС — сессия stopped, процесс не поднимается, в журнале session_os_stop", async () => {
    st = await stand();
    const { s, proc } = await st.open("site");
    proc.exit(0, "", null, true);
    await until(() => s.state === "stopped", 5000, "stopped");
    await tick();
    expect(st.holders.spawns).toHaveLength(1);
    expect(logged("session_os_stop")[0]).toMatchObject({ callsign: CS });
  });

  // устав: «процесс claude умер — один resume, второй сбой до готовности — failed»
  it("session.open: процесс вышел до готовности — open_failed, сессия в картине делает один resume; второй сбой — failed", async () => {
    st = await stand();
    st.holders.failInitNext = 2;
    const opening = st.request("session.open", { to: "@laptop", spec: { name: "site", cwd: st.dir } }, PULT);
    await until(() => st!.holders.procs.get(CS)?.initializes === 1, 5000, "первый процесс");
    st.holders.procs.get(CS)!.exit(1, "упал до готовности");
    expect(await opening).toMatchObject({ ok: false, error: "open_failed" });
    const s = st.kernel.sessions.get(CS)!;
    await until(() => st!.holders.spawns.length === 2 && st!.holders.procs.get(CS)?.initializes === 1, 5000, "resume");
    st.holders.procs.get(CS)!.exit(1, "упал снова");
    await until(() => s.state === "failed", 5000, "failed");
    expect(st.link.rows(CS).at(-1)!.row).toMatchObject({ state: "failed", error: expect.stringContaining("второй сбой до готовности") });
    expect(st.holders.spawns).toHaveLength(2);
  });

  it("session.open: вклад модуля в запуск бросил — open_failed с именем модуля; сессии и процесса нет", async () => {
    const picky: Module = { name: "picky", compose() { throw new Error("нет набора"); } };
    st = await stand({ modules: [picky] });
    const r = await st.request("session.open", { to: "@laptop", spec: { name: "site", cwd: st.dir } }, PULT);
    expect(r).toMatchObject({ ok: false, error: "open_failed" });
    expect(String((r as any).why)).toContain("picky");
    expect(st.kernel.sessions.has(CS)).toBe(false);
    expect(st.holders.spawns).toHaveLength(0);
  });
});

describe("план v2: стоп и старт сессии", () => {
  // договор: «Остановить процесс сессии; разговор сохраняется», «Запустить остановленную сессию: разговор возобновляется»
  it("stop: процесс вышел, в записи stopped; start поднимает тот же разговор; ведомый пары запущен тоже", async () => {
    st = await stand();
    await st.request("session.open", { to: "@laptop", spec: { name: "lead", cwd: st.dir }, pair: true }, PULT);
    const lead = st.kernel.sessions.get("lead@laptop")!, wing = st.kernel.sessions.get("lead-wing@laptop")!;
    const sid = lead.rec.sessionId;
    expect(await st.request("session.stop", { to: "lead@laptop" }, PULT)).toMatchObject({ ok: true });
    expect([lead.state, wing.state, lead.rec.stopped]).toEqual(["stopped", "stopped", true]);
    expect(st.holders.procs.has("lead@laptop")).toBe(false);
    expect(await st.request("session.start", { to: "lead@laptop" }, PULT)).toMatchObject({ ok: true });
    await until(() => lead.state === "idle" && wing.state === "idle", 5000, "пара запущена");
    expect((st.sdk.last("lead@laptop")!.options as any).resume).toBe(sid);
    expect(lead.rec.stopped).toBe(false);
  });

  // устав: «второе падение — failed, дальше решает агент»; чистый перезапуск начинает с хранилища
  it("start сессии в failed — чистый перезапуск: процесс поднят, причины сбоя в строке нет", async () => {
    st = await stand();
    const { s, proc } = await st.open("site");
    st.holders.failInitNext = 1;
    proc.exit(1, "упал");
    await until(() => st!.holders.procs.get(CS)?.failInit, 5000, "неготовый процесс");
    st.holders.procs.get(CS)!.exit(1, "не поднялся");
    await until(() => s.state === "failed", 5000, "failed");
    expect(await st.request("session.start", { to: CS }, PULT)).toMatchObject({ ok: true });
    await until(() => s.state === "idle", 5000, "idle");
    expect((st.link.rows(CS).at(-1)!.row as any).error).toBeUndefined();
  });

  it("start: процесс не поднялся — open_failed; сессия не остаётся stopped: один resume, второй сбой — failed", async () => {
    st = await stand();
    const { s } = await st.open("site");
    await st.request("session.stop", { to: CS }, PULT);
    st.holders.failInitNext = 2;
    const starting = st.request("session.start", { to: CS }, PULT);
    await until(() => st!.holders.procs.get(CS)?.initializes === 1, 5000, "первый процесс");
    st.holders.procs.get(CS)!.exit(1, "упал до готовности");
    expect(await starting).toMatchObject({ ok: false, error: "open_failed" });
    await until(() => st!.holders.spawns.length === 3 && st!.holders.procs.get(CS)?.initializes === 1, 5000, "resume");
    st.holders.procs.get(CS)!.exit(1, "упал снова");
    await until(() => s.state === "failed", 5000, "failed");
  });

  // устав: graceful shutdown — «доводит или отдаёт текущее»
  it("stop посреди хода: ход прерван, затем ввод закрыт и процесс вышел", async () => {
    st = await stand();
    const { s, proc } = await st.open("site");
    proc.busy = true;
    proc.send({ type: "system", subtype: "session_state_changed", state: "running", session_id: "s" });
    await until(() => s.state === "busy", 5000, "busy");
    expect(await st.request("session.stop", { to: CS }, PULT)).toMatchObject({ ok: true });
    expect(proc.interrupts).toBe(1);
    const ops = st.holders.ops.filter((o) => o.id === CS).map((o) => o.op);
    expect([ops.at(-1), ops.includes("kill")]).toEqual(["close_input", false]);
    expect(s.state).toBe("stopped");
  });

  // устав: «не успела — жёсткий выход, это ожидаемая ветка»
  it("stop: ход не кончился за предел ступени — kill, сессия stopped, в журнале stop_late", async () => {
    st = await stand();
    const { s, proc } = await st.open("site");
    proc.busy = true;
    proc.noInterrupt = true;
    proc.send({ type: "system", subtype: "session_state_changed", state: "running", session_id: "s" });
    await until(() => s.state === "busy", 5000, "busy");
    const stopping = st.request("session.stop", { to: CS }, PULT);
    await until(() => proc.interrupts === 1, 5000, "прерывание ушло");
    st.clock.advance(30_000);
    expect(await stopping).toMatchObject({ ok: true });
    expect(st.holders.ops.some((o) => o.op === "kill" && o.id === CS)).toBe(true);
    expect(s.state).toBe("stopped");
    expect(logged("stop_late")[0]).toMatchObject({ callsign: CS });
  });

  // чьё: код — запись после согласия SDK: отвергнутая модель проваливала бы каждый ход после resume
  it("session.update: Claude отверг модель — sdk_error, модель в документе прежняя", async () => {
    st = await stand();
    const { s, q } = await st.open("site", { model: "claude-fable-5-2" });
    (q as any).setModel = async () => {
      throw new Error("модель недоступна");
    };
    expect(await st.request("session.update", { to: CS, patch: { model: "нет-такой" } }, PULT)).toMatchObject({ ok: false, error: "sdk_error" });
    expect(s.rec.spec.model).toBe("claude-fable-5-2");
  });
});

describe("план v2: связь и остановка Host", () => {
  // устав: «прямой запрос … не прошёл — отказ словом»
  it("запрос через соединение ждал ответа, соединение оборвалось — отказ offline сразу", async () => {
    st = await stand();
    const waiting = st.kernel.call(sessionStop, { to: "docs@server" });
    await until(() => st!.link.of("session.stop").length === 1, 5000, "запрос ушёл");
    st.link.drop();
    await expect(waiting).rejects.toMatchObject({ word: "offline" });
    // и запрос, пришедший уже без соединения, — тоже сразу
    await expect(st.kernel.call(sessionStop, { to: "docs@server" })).rejects.toMatchObject({ word: "offline" });
  });

  // чьё: код; устав: «система ловит» — останавливает, пишет причину
  it("соединение закрыто без права переподключения — штатная остановка: link_stopped, выход 0, процессы живы", async () => {
    st = await stand();
    const { proc } = await st.open("site");
    st.link.stop();
    await until(() => st!.exits.length === 1, 5000, "выход");
    expect(st.exits).toEqual([0]);
    expect(logged("link_stopped")).toHaveLength(1);
    expect(proc.alive).toBe(true);
  });

  // устав: «не принимает новое → доводит или отдаёт текущее → … закрывает соединения»
  it("остановка Host: начатый запрос доведён и ответ ушёл до stop модулей; stop — в обратном порядке списка", async () => {
    const order: string[] = [];
    let release = () => {};
    const slow: Module = {
      name: "host-shell",
      requests: { "shell.info": () => new Promise((r) => (release = () => (order.push("ответ"), r({ os: "linux", shells: [], home: "/" })))) },
      stop: () => void order.push("stop host-shell"),
    };
    const other: Module = { name: "other", stop: () => void order.push("stop other") };
    st = await stand({ modules: [slow, other] });
    const asking = st.request("shell.info", { to: "@laptop" });
    await tick();
    const down = st.kernel.shutdown("SIGTERM");
    await tick();
    expect(order).toEqual([]);
    release();
    expect(await asking).toMatchObject({ ok: true, result: { os: "linux" } });
    await down;
    expect(order).toEqual(["ответ", "stop other", "stop host-shell"]);
    expect(st.exits).toEqual([0]);
  });

  // устав: «не успела — жёсткий выход, это ожидаемая ветка»
  it("остановка не успела за предел — выход 1, в журнале shutdown_late с тем, чего ждала; процессы живы", async () => {
    const stuck: Module = { name: "stuck", stop: () => new Promise(() => {}) };
    st = await stand({ modules: [stuck] });
    const { proc } = await st.open("site");
    const down = st.kernel.shutdown("SIGTERM");
    await tick();
    st.clock.advance(30_000);
    await down;
    expect(st.exits).toEqual([1]);
    expect(String(logged("shutdown_late")[0]!.why)).toContain("stuck");
    expect(proc.alive).toBe(true);
  });

  // устав: «система ловит» — не пускает ошибку дальше
  it("решение за человека бросило — инструмент не разрешён: deny module_failed, строка журнала, сессия работает", async () => {
    const judge: Module = { name: "judge", decide() { throw new Error("сломан"); } };
    st = await stand({ modules: [judge] });
    const { s, proc } = await st.open("site");
    expect(await proc.ask("Bash", { command: "ls" })).toEqual({ behavior: "deny", message: "module_failed" });
    expect(st.journal().some((l) => l.level === "error" && l.module === "judge")).toBe(true);
    await st.turn(CS);
    expect(s.state).toBe("idle");
  });
});
