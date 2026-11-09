// Леса ядра, договор модуля: старт и остановка Host, гейт, ловушка ошибок, вклады, запросы, кадры, связь, хранилище, журнал.
// Настоящее ядро на стенде: поддельные SDK, relay, держатели и часы. Источник свойства — в комментарии теста, без пометки — чьё: код.
// Процесс main.ts — boundary-process.test.ts, жизнь сессии — boundary-session.test.ts.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAME } from "@switchboard/protocol";
import { claudeDir, clientPath, content, isRefusal, refuse, tildePath } from "../contract.ts";
import type { Host, Module } from "../contract.ts";
import { FakeRelay, msg, module, standHost, turn, until } from "../stand/index.ts";
import type { Stand } from "../stand/index.ts";
import { CS, core, cost, keeper, lines, stand, stands } from "./kit.ts";

describe("старт и остановка Host", () => {
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


  it("152 · hello закрыт gate_unavailable дважды — сессии поднимаются, Host готов, переподключение, третий принят, строк stop нет; contract_mismatch — без переподключений, stop в журнале, сессии работают", async () => {
    // источник: устав «соединение с объектом relay оборвалось — клиенты переподключаются»; «Часть падает… одна, остальные ждут»
    const st = await stand({ sessions: [{ callsign: CS }], modules: [cost()], start: false, pauseMs: 5 });
    st.relay.refuse = ["gate_unavailable", "gate_unavailable"];
    await st.start();
    expect(lines(st, "ready")).toHaveLength(1);
    expect(st.kernel.sessions.get(CS)!.state).toBe("idle");
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
    await st2.open(CS);
    turn(st2.proc(CS));
    await until(() => st2.session("host-cost", CS)!.store<{ turns: number }>().get()?.turns === 1);
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

  it("кадр в окно остановки: модуль его не получает, строка журнала с причиной", async () => {
    // чьё: код — чистый перезапуск без следа оставил бы кадр потерянным молча
    const seen = vi.fn();
    const st = await stand({ holders: await keeper(), modules: [module("host-x", { frames: { "x.frame": seen } }, { provides: { "x.frame": 1 } })] });
    const down = st.kernel.shutdown("ввод закрыт");
    st.relay.deliver({ type: "x.frame", v: 1, from: "telegram~a@b.c" });
    await down;
    expect(seen).not.toHaveBeenCalled();
    expect(lines(st, "frame")).toEqual([expect.objectContaining({ kind: "refuse", word: "shutting_down", from: "telegram~a@b.c" })]);
  });

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


  it("7303 · relay отказал пропуску машины (revoked, bad_key) — Host выходит штатно с причиной, процессы claude живут у держателей: keeper поднимет Host с нынешним machine.key", async () => {
    // источник: устав — часть машины умерла: один перезапуск, второе падение — failed; бэклог 3 нояб. «Host держит старый пропуск в памяти»
    for (const word of ["revoked", "bad_key"]) {
      const st = await stand({ modules: [] });
      const site = await st.open("site@laptop");
      const p = st.proc("site@laptop");
      st.relay.conns.at(-1)!.drop(1008, word);
      await until(() => st.exits.length === 1);
      expect(st.exits).toEqual([0]);
      expect(lines(st, "relay_stopped")[0]).toMatchObject({ kind: "stop", word });
      expect(lines(st, "shutdown")[0].why).toContain(word);
      expect(p.alive).toBe(true);
      expect(site.state).not.toBe("stopped");
    }
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
        st.relay.deliver({ type: "poke", callsign: "docs@win" });
        got = await host.request("who", { v: 1 });
      },
    };
    const st = await stand({ machine: "win", modules: [module("host-owner", owner), module("host-caller", caller, { uses: { "who@host-owner": 1 } })] });
    await st.close();
    expect(got).toEqual({ ok: false, error: "shutting_down" });
    expect(called).toBe(0);
    expect(st.journal().some((l) => l.ev === "request" && l.word === "shutting_down")).toBe(true);
  });
});

describe("гейт старта", () => {
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


  it("calls: каждый метод Query SDK либо разрешён, либо держит ядро; функции сессии — с её id и папкой; прочего нет в SDK", async () => {
    // источник: устав «только документированные интерфейсы… исключения»; вход: sdk.d.ts закреплённой версии
    const { createRequire } = await import("node:module");
    const d = readFileSync(join(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"), "..", "sdk.d.ts"), "utf8");
    const q = d.slice(d.indexOf("export declare interface Query extends"));
    const methods = [...q.slice(0, q.search(/\r?\n\}/)).matchAll(/^    ([a-zA-Z_]+)\(/gm)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(20);
    const st = await stand({ modules: methods.map((m, i) => module(`host-${i}`, {}, { calls: [m] })) });
    for (const l of lines(st, "module_failed")) expect(l.why).toContain("метод держит ядро");

    const fns = module("host-f", {}, { calls: ["getSessionInfo", "tagSession", "forkSession", "deleteSession", "listSubagents", "getSubagentMessages"] });
    const st2 = await stand({ modules: [fns] });
    expect(lines(st2, "module_failed")).toEqual([]);
    await st2.open(CS);
    const s = st2.session("host-f", CS)!;
    for (const [name, ...args] of [["getSessionInfo"], ["tagSession", "t"], ["forkSession"], ["deleteSession"], ["listSubagents"], ["getSubagentMessages", "ag"]] as Array<[string, ...unknown[]]>) {
      await s.sdk(name, ...args);
      expect(st2.sdk.fnCalls.at(-1)).toEqual({ name, args: [s.info.session_id, ...args, { dir: s.info.cwd }] });
    }
    const st3 = await stand({ modules: [module("host-g", {}, { calls: ["listSessions"] })] });
    expect(lines(st3, "module_failed")[0].why).toContain("calls listSessions — такого метода нет в SDK");
  });
});

describe("ловушка ошибок модуля", () => {
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

  it("ответ модуля не ложится в JSON: Host жив, причина в журнале, другие запросы отвечают", async () => {
    // источник: устав «ошибка модуля — модуль выключен», Host не падает из-за модуля; строка журнала — «система ловит»
    const st = await stand({ modules: [module("host-bad", { requests: { "bad.big": () => ({ n: 1n }), "bad.ok": () => "да" } })] });
    void st.relay.request({ type: "bad.big", v: 1 });
    await until(() => lines(st, "reply").length);
    expect(lines(st, "reply")[0]).toMatchObject({ kind: "stop", word: "module_error" });
    expect(String(lines(st, "reply")[0].why)).toContain("bad.big");
    expect(await st.relay.request({ type: "bad.ok", v: 1 })).toMatchObject({ ok: true, result: "да" });
  });

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
    const st = await stand({ machine: "win", modules: [module("host-owner", owner), module("host-other", other), module("host-caller", {}, { uses: { "who@host-owner": 1 } })] });
    await st.open("docs@win");
    expect(await st.host("host-caller").request("who", { v: 1, callsign: "docs@win" })).toEqual({ ok: false, error: "module_error" });
    await until(() => st.states("docs@win").at(-1)?.failed?.["host-owner"]);
    expect(st.journal().some((l) => l.ev === "module_failed" && l.module === "host-owner" && l.callsign === "docs@win" && String(l.why).includes("бах"))).toBe(true);
    expect(await st.relay.request({ type: "who", v: 1, callsign: "docs@win" })).toMatchObject({ ok: false, error: "module_error" });
    expect(calls).toBe(1);
    expect(await st.relay.request({ type: "ping", v: 1, callsign: "docs@win" })).toMatchObject({ ok: true, result: "pong" });
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

  it("отказ словом вне запроса (кадр, on.event, хук): строка refuse, Host и модуль живут", async () => {
    // источник: опыт на прежнем коде — отказ в обработчике кадра уходил в клиент рации, в хуке — необработанным; контракт «это не ошибка модуля»
    const st = await stand({
      modules: [module("host-r", {
        frames: { "r.f": () => { throw refuse("nope3", "п3"); } },
        session: () => ({ hooks: { Stop: [{ hooks: [async () => { throw refuse("nope5", "п5"); }] }] } }),
        on: { event: () => { throw refuse("nope6", "п6"); } },
        requests: { "r.q": () => "да" },
      })],
    });
    await st.open(CS);
    st.relay.deliver({ type: "r.f", callsign: CS });
    expect(await st.proc(CS).hook("Stop", {})).toEqual([{}]);
    st.proc(CS).send(msg.assistant("x"));
    await until(() => lines(st).filter((l) => l.kind === "refuse" && ["nope3", "nope5", "nope6"].includes(l.word)).length === 3);
    expect(lines(st, "module_failed")).toEqual([]);
    expect(await st.relay.request({ type: "r.q", v: 1, callsign: CS })).toMatchObject({ ok: true, result: "да" });
  });

  it("отказ словом в решении: deny со строкой журнала, модуль не выключен — следующий вызов идёт к нему", async () => {
    // источник: контракт Module «Отказ словом своего контракта… это не ошибка модуля»
    let n = 0;
    const st = await stand({ modules: [module("host-d", { decide: { Bash: () => { if (++n === 1) throw refuse("nope", "причина"); return { behavior: "allow", updatedInput: {} }; } } })] });
    await st.open(CS);
    expect(await st.proc(CS).ask("Bash", {})).toEqual({ behavior: "deny", message: "module_error" });
    expect(await st.proc(CS).ask("Bash", {})).toMatchObject({ behavior: "allow" });
    expect(lines(st, "module_failed")).toEqual([]);
  });
});

describe("вклады в query()", () => {
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

  it("у ключа один владелец: сервер MCP, settings, опция — отказ open с именем ключа", async () => {
    // источник: устав «у… MCP-сервера, ключа env… — один модуль; двое — Host не стартует»; слова — чьё: код
    const a = module("host-a", { session: () => ({ mcpServers: { x: { type: "sdk", name: "x" } as never }, settings: { t: 1 }, model: "m" }) });
    for (const [key, value, why] of [
      ["mcpServers", { x: { type: "sdk", name: "x" } }, "MCP-сервер x: два владельца — host-a и host-b"],
      ["settings", { t: 2 }, "settings t: два владельца — host-a и host-b"],
      ["model", "n", "опция model: два владельца — host-a и host-b"],
    ] as const) {
      const st = await stand({ modules: [a, module("host-b", { session: () => ({ [key]: value }) })] });
      await expect(st.open(CS)).rejects.toThrow(why);
    }
  });

  it("строки промпта и хуки складываются по порядку модулей; прочая опция — как есть; окружение машины идёт процессу", async () => {
    // источник: контракт QueryPart «Хуки и append складываются списком»; разделитель — чьё: код
    const h = async () => ({});
    const st = await stand({ modules: [module("host-a", { session: () => ({ append: "A", foo: 1, hooks: { Stop: [{ hooks: [h] }] } }) }), module("host-b", { session: () => ({ append: "B", hooks: { Stop: [{ hooks: [h] }] } }) })] });
    await st.open(CS);
    const o = st.query(CS).options as Record<string, any>;
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "A\n\nB" });
    expect(o.foo).toBe(1);
    expect(o.hooks.Stop).toHaveLength(2);
    const plain = await stand({ modules: [] });
    await plain.open(CS);
    expect(plain.query(CS).options).toMatchObject({ mcpServers: {}, hooks: {}, systemPrompt: { type: "preset", preset: "claude_code" } });
    process.env.SWITCHBOARD_PROBE_ENV = "1";
    const later = await stand({ modules: [] });
    await later.open(CS);
    expect(later.query(CS).options.env!.SWITCHBOARD_PROBE_ENV).toBe("1");
    delete process.env.SWITCHBOARD_PROBE_ENV;
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

  it("порядок вызовов модуля: session до состояния, on.state до on.event и on.open; on.close до нового старта", async () => {
    // источник: чьё: код — модули читают s.state в этих вызовах
    const ev: string[] = [];
    const m = module("host-w", {
      session: (s) => void ev.push(`session ${s.state} ${s.info.start}`),
      on: {
        open: (s) => void ev.push(`open ${s.state}`),
        close: (s) => void ev.push(`close ${s.state}`),
        state: (_s, x) => void ev.push(`state ${x}`),
        event: (s, x) => void ev.push(`event ${x.type} ${s.state}`),
      },
    });
    const st = await stand({ modules: [m] });
    const s = await st.open(CS);
    expect(ev.splice(0)).toEqual(["session starting spawn", "state idle", "open idle"]);
    turn(st.proc(CS));
    await until(() => ev.filter((x) => x.startsWith("event")).length === 4);
    expect(ev.splice(0)).toEqual(["state busy", "event system busy", "event assistant busy", "event result busy", "state idle", "event system idle"]);
    st.holders.failInitNext = 1;
    st.proc(CS).exit(1, "первый");
    await until(() => st.holders.procs.get(CS)?.initializes === 1 && st.sdk.of(CS).length === 2);
    expect(ev.splice(0)).toEqual(["close idle", "state starting", "session starting resume"]);
    st.proc(CS).exit(1, "второй");
    await until(() => s.state === "failed");
    expect(ev.splice(0)).toEqual(["close starting", "state failed"]);
  });
});

describe("только свои переменные", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("1 · подброшенный путь к слоту, ключ и токен стёрты, в журнале только имена; путь к bash остался", async () => {
    // источник: факт — hz-ex44-win-1, переменная на уровне машины; слово пользователя 5 нояб.
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/чужой/слот";
    process.env.ANTHROPIC_API_KEY = "секрет-ключа";
    process.env.CLAUDE_CODE_GIT_BASH_PATH = "/bin/bash";
    const m = module("host-manage", {}, { calls: ["claudeAuthenticate"] });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    const session = st.query("site@laptop").options.env as Record<string, string | undefined>;
    st.host("host-manage").probe({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/своя" } }).close();
    const probe = st.sdk.queries.at(-1)!.options.env as Record<string, string | undefined>;
    expect(session.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(session.ANTHROPIC_API_KEY).toBeUndefined();
    expect(session.CLAUDE_CODE_GIT_BASH_PATH).toBe("/bin/bash");
    expect(probe.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/своя");
    const line = st.journal().find((l) => l.ev === "env_dropped")!;
    expect(line.why).toContain("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    expect(line.why).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(line)).not.toContain("секрет-ключа");
    expect(JSON.stringify(line)).not.toContain("/чужой/слот");
  });

  it("2 · сессия, короткий процесс и claude auth получают папку Host, стандартной нет ни в одном окружении", async () => {
    // источник: слово пользователя 5 нояб. «вообще не использовать стандартную клауде на хосте»
    delete process.env.CLAUDE_CONFIG_DIR;
    const m = module("host-manage", {}, { calls: ["claudeAuthenticate"] });
    const st = await stand({ modules: [m] });
    await st.open("site@laptop");
    const own = join(st.home, "claude");
    expect(claudeDir()).toBe(own);
    expect(existsSync(own)).toBe(true);
    expect((st.query("site@laptop").options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(own);
    st.host("host-manage").probe().close();
    expect((st.sdk.queries.at(-1)!.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(own);
    await st.host("host-manage").cli(["auth", "status"]);
    expect(st.sdk.cliCalls.at(-1)!.env.CLAUDE_CONFIG_DIR).toBe(own);
  });

});

describe("запрос открытия", () => {
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

  it("упавший opening: открытие отказано, другое открытие тем же модулем идёт — модуль выключен только в той сессии", async () => {
    // источник: устав «ошибка модуля — модуль выключен в этой сессии»; чьё: код
    let n = 0;
    const st = await stand({ modules: [module("host-o", { opening() { if (++n === 1) throw new Error("бах"); } })] });
    await expect(st.open("a@laptop", { opening: {} })).rejects.toMatchObject({ word: "module_error" });
    await st.open("b@laptop", { opening: {} });
    expect(n).toBe(2);
    expect(lines(st, "module_failed")[0]).toMatchObject({ callsign: "a@laptop", module: "host-o" });
    expect(lines(st, "module_failed")[0].why).toContain("; модуль выключен в сессии");
  });

  it("opening зовётся и без поля в запросе: открытие модулем без слота не идёт мимо модуля слотов", async () => {
    // источник: контракт Module.opening; чьё: код — запрос открытия пустой, а не пропущенный
    const got: unknown[] = [];
    const st = await stand({ modules: [module("host-o", { opening(_s, req) { got.push(req); } })] });
    await st.open(CS);
    expect(got).toEqual([{}]);
  });

});

describe("решения и формы", () => {
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

  it("716 · владелец decide решает инструмент: ответ владельца — процессу; владелец получил input и toolUseID", async () => {
    // источник: чьё: код — контракт «Решение по инструменту из canUseTool; у инструмента один владелец»
    const got: unknown[] = [];
    const a = module("host-a", { decide: { Bash: (_s, input, o) => { got.push([input, o.toolUseID]); return { behavior: "deny", message: "нельзя" }; } } });
    const st = await stand({ modules: [a] });
    await st.open(CS);
    expect(await st.proc(CS).ask("Bash", { command: "rm" }, "toolu_9")).toEqual({ behavior: "deny", message: "нельзя" });
    expect(got).toEqual([[{ command: "rm" }, "toolu_9"]]);
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
});

describe("запросы и кадры", () => {
  it("705 · кадр без владельца и подписчиков — строка refuse unknown_request с типом кадра", async () => {
    // источник: устав «система ловит… пишет в журнал с причиной»
    const st = await stand({ modules: [module("host-a", {})] });
    st.relay.deliver({ type: "nobody", x: 1 });
    await until(() => lines(st, "frame").some((l) => String(l.why).includes("nobody")));
    expect(lines(st, "frame").find((l) => String(l.why).includes("nobody"))).toMatchObject({ kind: "refuse", word: "unknown_request" });
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

  it("запрос модуля этой машины: своё имя и имя другого модуля — в процессе, без relay; отправитель — from запроса, иначе машина", async () => {
    const seen: Array<string | undefined> = [];
    const owner: Module = { requests: { who: (_f, ctx) => (seen.push(ctx.from), "я") } };
    const st = await stand({ machine: "win", modules: [module("host-owner", owner, { provides: { who: 1 } }), module("host-caller", {}, { uses: { "who@host-owner": 1 } })] });
    expect(await st.host("host-owner").request("who", { v: 1, from: "lead@win" })).toEqual({ ok: true, result: "я" });
    expect(await st.host("host-caller").request("who", { v: 1 })).toEqual({ ok: true, result: "я" });
    expect(seen).toEqual(["lead@win", "@win"]);
    expect(st.relay.frames("who")).toEqual([]);
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

  it("запрос к Worker'у не прошёл: отказ словом, модуль жив", async () => {
    // источник: устав, ожидаемая ветка «прямой запрос к Worker'у не прошёл — отказ словом»
    const relayStand = new FakeRelay();
    relayStand.workersDown = true;
    let host!: Host;
    const st = await stand({ relayStand, modules: [module("host-a", { start: (h) => void (host = h) }, { uses: { "push.send@push": 1 } })] });
    expect(await host.request("push.send", { v: 1 })).toMatchObject({ ok: false, error: "offline" });
    expect(lines(st, "module_failed")).toEqual([]);
  });

  it("host.read через relay: нет ответа за 10 с — timeout, модуль жив", async () => {
    // источник: слово пользователя 4 нояб. «таймаут операций на запрос метадаты 10 секунд»; контракт Host.read
    let host!: Host;
    const st = await stand({ modules: [module("host-a", { start: (h) => void (host = h) }, { uses: { "x.read@host-b": 1 } })] });
    await until(() => st.relay.hellos.length === 1 && lines(st, "hello").length === 1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let got: unknown;
    void host.read("x.read", { callsign: "api@pc" }).then((r) => (got = r));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toMatchObject({ ok: false, error: "timeout" });
    vi.useRealTimers();
    expect(lines(st, "module_failed")).toEqual([]);
  });
});

describe("кадры наружу и связь", () => {
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

  it("roster и кадр roster модулю — весь флот: соединения машин вместе; обрыв машины не стирает последний", async () => {
    // источник: устав «Ядро держит соединение с relay каждой машины флота»; контракт Host.roster «Последний roster»; чьё: код
    let host!: Host;
    const got: any[] = [];
    const st = await stand({ pauseMs: 100_000, modules: [module("host-c", { start: (x) => void (host = x), on: { frame: (f) => void got.push(f) } }, { uses: { "roster@relay": 1 } })] });
    await until(() => host.roster());
    st.relay.deliver({ type: "roster", machines: [{ machine: "laptop", since: 1, proto: 1 }], sessions: [{ callsign: "a@laptop" }], clients: ["@pc", "x~y@z"] });
    await until(() => st.relay.conns.length === 2 && st.relay.conns[1].readyState === 1);
    st.relay.conns[1].deliver(JSON.stringify({ type: "roster", machines: [{ machine: "pc", since: 2, proto: 1 }], sessions: [{ callsign: "b@pc" }], clients: ["z~y@z"] }));
    await until(() => host.roster()?.sessions.length === 2);
    expect(got.at(-1).sessions).toEqual([{ callsign: "a@laptop" }, { callsign: "b@pc" }]);
    expect(host.roster()!.clients).toEqual(["x~y@z", "z~y@z"]);
    st.relay.conns[1].drop(1006, "обрыв");
    await until(() => lines(st, "guest_closed").length === 1);
    expect(lines(st, "guest_open")[0].why).toBe("pc");
    expect(lines(st, "guest_closed")[0].why).toBe("pc · обрыв");
    expect(host.roster()!.sessions).toHaveLength(2);
  });
});

describe("поля и сессия глазами модуля", () => {
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


  it("s.field: поле сессии этой машины от владельца — без relay; имени нет в uses — модуль выключен в сессии", async () => {
    let got: unknown;
    const owner: Module = { fields: { parent: () => "lead@win" } };
    const reader: Module = { on: { open: (s) => void (got = s.field("parent")) } };
    const stranger: Module = { on: { open: (s) => void s.field("parent") } };
    const st = await stand({
      machine: "win",
      modules: [module("host-owner", owner), module("host-reader", reader, { uses: { "parent@host-owner": 1 } }), module("host-stranger", stranger)],
    });
    await st.open("docs@win");
    expect(got).toBe("lead@win");
    await until(() => st.states("docs@win").at(-1)?.failed?.["host-stranger"]);
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
    const st = await stand({ machine: "win", modules: [module("host-owner", owner), module("host-reader", {}, { uses: { "parent@host-owner": 1 } })] });
    await st.open("docs@win");
    await until(() => st.states("docs@win").at(-1)?.failed?.["host-owner"]);
    expect(st.session("host-reader", "docs@win")!.field("parent")).toBeUndefined();
    st.session("host-reader", "docs@win")!.refresh();
    expect(Object.keys(st.states("docs@win").at(-1)!.failed)).toEqual(["host-owner"]);
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
});

describe("хранилище и журнал", () => {
  const owner = (name: string) => module(name, {});
  const file = (st: Stand, name: string) => JSON.parse(readFileSync(join(st.home, "store", name + ".json"), "utf8"));

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

  it("65 · разделы сессии и машины записаны; Host убит; новый Host после start() отдаёт то же поле и ответ; файл — целый JSON", async () => {
    // источник: устав «После перезапуска Host модуль поднимает своё из хранилища»
    const k = await keeper();
    const st = await stand({ holders: k, modules: [cost()] });
    await st.open("site@laptop");
    st.host("host-cost").store<string>().set("машина");
    turn(st.proc("site@laptop"));
    await until(() => (st.states("site@laptop").at(-1)?.cost as { turns: number })?.turns === 1);
    st.crash();
    const st2 = await stand({ holders: k, home: st.home, modules: [cost()] });
    expect((st2.relay.hellos[0].sessions as Array<Record<string, unknown>>)[0]).toMatchObject({ callsign: "site@laptop", cost: { usd: 0.012, turns: 1 } });
    expect(await st2.relay.request({ type: "session.cost", v: 1, callsign: "site@laptop" })).toMatchObject({ ok: true, result: { usd: 0.012, turns: 1 } });
    expect(st2.host("host-cost").store().get()).toBe("машина");
    const file = JSON.parse(readFileSync(join(st.home, "store", "host-cost.json"), "utf8"));
    expect(file.sessions["site@laptop"]).toEqual({ usd: 0.012, turns: 1 });
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
});

describe("ввод и папки", () => {
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
});

describe("сверка круга 3: упавшие отложенные и правила из строк старого кода", () => {
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

  it("поле-обещание в запись не идёт; разделы сессии стираются и у модуля, которого нет в сборке", async () => {
    // источник: чьё: код — запись roster синхронна; контракт Session.remove «разделы этой сессии у всех модулей стёрты»
    const st = await stand({ modules: [module("host-a", { fields: { later: (async () => 1) as never } })] });
    const s = await st.open(CS);
    writeFileSync(join(st.home, "store", "host-old.json"), JSON.stringify({ sessions: { [CS]: 1, "x@laptop": 2 } }));
    expect(st.states(CS).at(-1)!.later).toBeUndefined();
    await s.remove();
    expect(JSON.parse(readFileSync(join(st.home, "store", "host-old.json"), "utf8")).sessions).toEqual({ "x@laptop": 2 });
  });

  it("поздний ответ на свой запрос: не запрос к модулю, отказа в журнале и кадра в relay нет", async () => {
    // источник: протокол — reply не запрос; чьё: код — ждавшему уже ответил предел
    const st = await stand({ modules: [] });
    await until(() => st.relay.hellos.length === 1 && lines(st, "hello").length === 1);
    st.relay.deliver({ type: "reply", id: "late-1", ok: true });
    await st.relay.request({ type: "y.do", v: 1 });
    expect(lines(st, "request").map((l) => l.word)).toEqual(["unknown_request"]);
    expect(st.relay.frames("reply").map((f) => f.id)).not.toContain("late-1");
  });

  it("второе открытие того же имени, пока первое идёт: отказ, процесс один", async () => {
    // источник: контракт host.open; чьё: код — запись появляется только после вкладов модулей
    let release = () => {};
    const st = await stand({ modules: [module("host-slow", { session: () => new Promise<undefined>((r) => (release = () => r(undefined))) })] });
    const first = st.open(CS);
    await until(() => release.toString().includes("r(undefined)"));
    await expect(st.open(CS)).rejects.toThrow("имя занято");
    release();
    await first;
    expect(st.sdk.of(CS)).toHaveLength(1);
  });

  it("module_failed несёт стек: журнал — то, по чему агент чинит модуль", async () => {
    // источник: устав «система ловит, агент чинит»
    const st = await stand({ modules: [module("host-a", { start: () => { throw new Error("бах"); } })] });
    expect(lines(st, "module_failed")[0].why).toContain("boundary.test.ts");
  });

  it("start() модуля видит сессии из хранилища", async () => {
    // источник: чьё: код — модули сверяют своё со списком сессий на старте
    let seen: string[] = [];
    const st = await stand({ sessions: [{ callsign: CS }], modules: [module("host-a", { start: (h) => void (seen = h.sessions().map((s) => s.callsign)) })] });
    expect(seen).toEqual([CS]);
    expect(st.startError).toBeNull();
  });
});

describe("сверка комментариев круга 3", () => {
  it("процесс сессии, поднятый по вызову модуля, — работа ядра: её сбой не выключает модуль", async () => {
    // источник: комментарий старого кода «то, что начато здесь, — дело ядра»; устав «ошибка модуля — модуль выключен», чужая — нет
    const k = keeper();
    const spawn = k.spawn.bind(k);
    let st!: Stand;
    let caught: boolean | undefined;
    k.spawn = async (s) => {
      caught = st.kernel.stray(new Error("сбой ядра"));
      return spawn(s);
    };
    const m = module("host-a", { requests: { "a.open": async (_f, { host }) => (await host.open({ callsign: CS, cwd: st.home })).info.callsign } });
    st = await stand({ holders: k, modules: [m] });
    expect(await st.relay.request({ type: "a.open", v: 1 })).toMatchObject({ ok: true, result: CS });
    expect(caught).toBe(false);
    expect(lines(st, "module_failed")).toEqual([]);
  });
});
