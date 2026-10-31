// Эталоны перезагрузки модулей в живом Host и эталоны экосистемы, которые проверяет ядро.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeKeeper, msg, module, release, standHost, turn, until } from "../stand/index.ts";
import type { Stand } from "../stand/index.ts";
import type { Host, Module } from "../contract.ts";

const stands: Stand[] = [];
const keepers: FakeKeeper[] = [];
async function stand(o: Parameters<typeof standHost>[0] = {}): Promise<Stand> {
  const st = await standHost(o);
  stands.push(st);
  return st;
}
afterEach(async () => {
  for (const st of stands.splice(0)) await st.close();
  for (const k of keepers.splice(0)) await k.close();
});
const lines = (st: Stand, ev?: string) => st.journal().filter((l) => !ev || l.ev === ev);

type Cost = { usd: number; turns: number };
/** Модуль расхода версии version; log — что с ним происходило. */
function cost(version: string, log: string[] = [], extra: Partial<Module> = {}, provides: Record<string, number> = {}) {
  const mod: Module = {
    fields: { cost: (s) => s.store<Cost>().get() ?? { usd: 0, turns: 0 } },
    start: () => void log.push(`start ${version}`),
    stop: () => void log.push(`stop ${version}`),
    on: {
      open: (s) => void log.push(`open ${version} ${s.info.callsign} ${s.info.start}`),
      event(s, m) {
        if (m.type !== "result") return;
        log.push(`result ${version}`);
        s.store<Cost>().update((c = { usd: 0, turns: 0 }) => ({ usd: c.usd + (m as { total_cost_usd: number }).total_cost_usd, turns: c.turns + 1 }));
      },
    },
    requests: { "session.cost": (req, { host }) => host.session(req.callsign as string)!.store().get() },
    ...extra,
  };
  return module("host-cost", mod, { version, provides });
}
const fleetPlain = () => module("host-fleet", { frames: { message: () => {} } }, { version: "1.2.0" });

describe("перезагрузка модулей в живом Host", () => {
  it("151 · contract в hello — provides списка; выпуск без host-cost — нет session.cost, запрос — unknown_request", async () => {
    const questions = module("host-questions", { requests: { answer: () => "ok" } });
    const st = await stand({ modules: [fleetPlain(), questions, cost("1.0.0")], releases: { "/r/1.4.1": release("1.4.1", [fleetPlain(), questions]) } });
    expect(st.relay.hellos[0].contract).toEqual({ message: 1, answer: 1, "session.cost": 1, cost: 1 });
    await st.open("site@laptop");
    const r = await st.host("host-fleet").reload("/r/1.4.1");
    expect(r).toMatchObject({ ok: true, result: { modules: { "host-cost": ["1.0.0", null] } } });
    await until(() => st.relay.hellos.length === 2);
    expect(st.relay.hellos[1].contract).toEqual({ message: 1, answer: 1 });
    expect(await st.relay.request({ type: "session.cost", v: 1, callsign: "site@laptop" })).toMatchObject({ ok: false, error: "unknown_request" });
  });

  it("252 · cost 1.0.0 → 1.1.0 посреди хода: stop, start, on.open attach; result получила 1.1.0; процесс и связь те же; ready 1.4.1", async () => {
    const log: string[] = [];
    let release1!: () => void;
    const held = new Promise<void>((r) => (release1 = r));
    const v1 = cost("1.0.0", log, { stop: async () => { log.push("stop 1.0.0"); await held; } });
    const v2 = cost("1.1.0", log);
    const st = await stand({ modules: [fleetPlain(), v1], releases: { "/r/1.4.1": release("1.4.1", [fleetPlain(), v2]) } });
    await st.open("site@laptop");
    const p = st.proc("site@laptop");
    const pid = p.pid;
    p.send(msg.state("running"));
    await until(() => st.kernel.sessions.get("site@laptop")!.state === "busy");
    const reloading = st.host("host-fleet").reload("/r/1.4.1");
    await until(() => log.includes("stop 1.0.0"));
    p.send(msg.result());
    p.send(msg.state("idle"));
    await until(() => st.kernel.sessions.get("site@laptop")!.state === "idle");
    expect(log).not.toContain("result 1.0.0");
    release1();
    const r = await reloading;
    expect(r).toEqual({ ok: true, result: { from: "1.4.0", to: "1.4.1", modules: { "host-cost": ["1.0.0", "1.1.0"] }, later: [] } });
    await until(() => log.includes("result 1.1.0"));
    expect(log).toEqual(["start 1.0.0", "open 1.0.0 site@laptop spawn", "stop 1.0.0", "start 1.1.0", "open 1.1.0 site@laptop attach", "result 1.1.0"]);
    await until(() => (st.states("site@laptop").at(-1)?.cost as Cost)?.turns === 1);
    expect(st.proc("site@laptop").pid).toBe(pid);
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(st.keeper.ops.filter((o) => o.op === "kill")).toEqual([]);
    expect(st.relay.conns).toHaveLength(1);
    expect(st.keeper.readies).toEqual(["1.4.0", "1.4.1"]);
    expect(st.kernel.version).toBe("1.4.1");
  });

  it("253 · fleet 1.3.0: setMcpServers без fleet, затем с новым; хук — тело 1.3.0; PostToolUse и append — later; после restart PostToolUse вызывается", async () => {
    const srv = (v: string) => ({ type: "sdk", name: "fleet", instance: { v } });
    const fleet = (v: string, post: boolean) =>
      module(
        "host-fleet",
        {
          session: (s) => ({
            mcpServers: { fleet: srv(v) as never },
            append: `Твой callsign — ${s.info.callsign}. fleet ${v}`,
            hooks: {
              PreToolUse: [{ matcher: "Bash", hooks: [async () => ({ systemMessage: `pre ${v}` })] }],
              ...(post ? { PostToolUse: [{ hooks: [async () => ({ systemMessage: `post ${v}` })] }] } : {}),
            },
          }),
        },
        { version: v },
      );
    const st = await stand({ modules: [fleet("1.2.0", false)], releases: { "/r/1.5.1": release("1.5.1", [fleet("1.3.0", true)]) } });
    const s = await st.open("site@laptop");
    const r = await st.host("host-fleet").reload("/r/1.5.1");
    expect(r).toMatchObject({ ok: true, result: { later: ["site@laptop"] } });
    const q = st.query("site@laptop");
    const mcp = q.calls.filter((c) => c.name === "setMcpServers").map((c) => c.args[0]);
    expect(mcp).toEqual([{}, { fleet: srv("1.3.0") }]);
    const p = st.proc("site@laptop");
    expect(await p.hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } })).toEqual([{ systemMessage: "pre 1.3.0" }]);
    expect(await p.hook("PostToolUse", { tool_name: "Bash" })).toEqual([]);
    const why = lines(st, "reload_later")[0].why;
    expect(why).toContain("PostToolUse");
    expect(why).toContain("append");
    expect(why).toContain("со следующего старта site@laptop");
    await s.restart();
    const p2 = st.proc("site@laptop");
    expect(p2.hookEvents).toEqual(["PreToolUse", "PostToolUse"]);
    expect(await p2.hook("PostToolUse", { tool_name: "Bash" })).toEqual([{ systemMessage: "post 1.3.0" }]);
    expect((st.query("site@laptop").options.systemPrompt as { append: string }).append).toContain("fleet 1.3.0");
  });

  it("254 · другое ядро — core_changed, ничего не тронуто; два владельца — check_failed, cost работает; ready нет; оба в журнале", async () => {
    const log: string[] = [];
    const dup = module("host-dup", { requests: { "session.cost": () => 0 } });
    const st = await stand({
      modules: [cost("1.1.0", log)],
      releases: {
        "/r/1.5.0": release("1.5.0", [cost("1.2.0")], { core: "1.1.0" }),
        "/r/1.4.2": release("1.4.2", [cost("1.2.0"), dup]),
      },
    });
    await st.open("site@laptop");
    expect(await st.host("host-cost").reload("/r/1.5.0")).toMatchObject({ ok: false, error: "core_changed" });
    const r2 = await st.host("host-cost").reload("/r/1.4.2");
    expect(r2).toMatchObject({ ok: false, error: "check_failed" });
    expect((r2 as { why: string }).why).toContain("session.cost: два владельца — host-cost и host-dup");
    expect(log).toEqual(["start 1.1.0", "open 1.1.0 site@laptop spawn"]);
    expect(await st.relay.request({ type: "session.cost", v: 1, callsign: "site@laptop" })).toMatchObject({ ok: true });
    expect(st.keeper.readies).toEqual(["1.4.0"]);
    expect(lines(st, "reload").map((l) => l.word)).toEqual(["core_changed", "check_failed"]);
  });

  it("255 · start() новой версии бросил: cost выключен на машине, ждавший запрос — module_error, 1.0.0 не поднят, ready нет, ходы идут", async () => {
    const log: string[] = [];
    let open!: () => void;
    const held = new Promise<void>((r) => (open = r));
    const v1 = cost("1.0.0", log, { stop: async () => { log.push("stop 1.0.0"); await held; } });
    const v2 = cost("1.1.0", log, { start: () => { throw new TypeError("start: сломался"); } });
    const st = await stand({ modules: [fleetPlain(), v1], releases: { "/r/1.4.1": release("1.4.1", [fleetPlain(), v2]) } });
    await st.open("site@laptop");
    await st.open("wiki@laptop");
    const reloading = st.host("host-fleet").reload("/r/1.4.1");
    await until(() => log.includes("stop 1.0.0"));
    const waiting = st.relay.request({ type: "session.cost", v: 1, callsign: "site@laptop" });
    open();
    expect(await reloading).toMatchObject({ ok: false, error: "module_error" });
    expect(await waiting).toMatchObject({ ok: false, error: "module_error" });
    for (const cs of ["site@laptop", "wiki@laptop"]) await until(() => (st.states(cs).at(-1)?.failed as Record<string, string>)?.["host-cost"]);
    expect(log).toEqual(["start 1.0.0", "open 1.0.0 site@laptop spawn", "open 1.0.0 wiki@laptop spawn", "stop 1.0.0"]);
    expect(st.keeper.readies).toEqual(["1.4.0"]);
    turn(st.proc("site@laptop"));
    await until(() => st.states("site@laptop").some((f) => f.state === "busy") && st.kernel.sessions.get("site@laptop")!.state === "idle");
  });

  it("256 · новое имя session.cost.reset: после start новый hello с ним; ждущий ответа poe-bot@pc запрос — disconnected; процессы не тронуты", async () => {
    let host!: Host;
    const fleet = module("host-fleet", { start: (h) => void (host = h), frames: { message: () => {} } }, { version: "1.2.0" });
    const v2 = cost("1.1.0", [], { requests: { "session.cost": () => 1, "session.cost.reset": () => true } }, { "session.cost.reset": 1 });
    const st = await stand({ modules: [fleet, cost("1.0.0")], releases: { "/r/1.4.1": release("1.4.1", [fleet, v2]) } });
    await st.open("site@laptop");
    const pid = st.proc("site@laptop").pid;
    const waiting = host.request("message", { v: 1, to: "poe-bot@pc", text: "отчёт?" });
    await until(() => st.relay.frames("message").length === 1);
    expect(await host.reload("/r/1.4.1")).toMatchObject({ ok: true });
    expect(await waiting).toEqual({ ok: false, error: "disconnected" });
    await until(() => st.relay.hellos.length === 2);
    expect(st.relay.hellos[1].contract).toMatchObject({ "session.cost.reset": 1 });
    expect(st.relay.clientCloses[0]).toEqual({ code: 1000, reason: "rehello" });
    expect(st.proc("site@laptop").pid).toBe(pid);
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
  });

  it("перезагрузка: ждущий человека decide прежней версии — новой заново с тем же toolUseID", async () => {
    const asked: string[] = [];
    const q = (v: string) =>
      module(
        "host-questions",
        {
          decide: {
            AskUserQuestion: (_s, input, o) => {
              asked.push(`${v} ${o.toolUseID}`);
              return v === "1.0.0" ? new Promise(() => {}) : { behavior: "allow", updatedInput: { ...input, answers: { "Цвет?": "Синий" } } };
            },
          },
        },
        { version: v },
      );
    const st = await stand({ modules: [q("1.0.0")], releases: { "/r/2": release("2", [q("1.1.0")]) } });
    await st.open("site@laptop");
    const answer = st.proc("site@laptop").ask("AskUserQuestion", { questions: [] }, "toolu_xd4WEnP8");
    await until(() => asked.length === 1);
    await st.host("host-questions").reload("/r/2");
    expect(await answer).toEqual({ behavior: "allow", updatedInput: { questions: [], answers: { "Цвет?": "Синий" } } });
    expect(asked).toEqual(["1.0.0 toolu_xd4WEnP8", "1.1.0 toolu_xd4WEnP8"]);
  });

  it("269 · перезагружаются оба: start слотов ждёт accounts — идёт новой версии, перезагрузка доходит до ready; запрос снаружи ждёт окна (живой прогон 1 ноя)", async () => {
    const log: string[] = [];
    let go!: () => void;
    const held = new Promise<void>((r) => (go = r));
    const acc = (v: string) =>
      module(
        "host-accounts",
        {
          async start() {
            log.push(`accounts start ${v}`);
            if (v === "2.0.0") await held; // окно держится, пока внешний запрос не встанет в него
          },
          requests: { "machine.accounts": () => ({ v }) },
        },
        { version: v },
      );
    const slots = (v: string) =>
      module(
        "host-slots",
        {
          async start(h: Host) {
            const r = await h.request("machine.accounts", { v: 1 });
            log.push(`slots start ${v} ← accounts ${JSON.stringify(r)}`);
          },
          requests: { "machine.slots": () => ({ v }) },
        },
        { version: v, uses: { "machine.accounts@host-accounts": 1 } },
      );
    const st = await stand({ modules: [acc("1.0.0"), slots("2.0.0")], releases: { "/r/1.4.1": release("1.4.1", [acc("2.0.0"), slots("3.0.0")]) } });
    log.length = 0;
    const reloading = st.host("host-accounts").reload("/r/1.4.1");
    // запрос снаружи, пока окно открыто, — ждёт и идёт новой версии
    await until(() => log.includes("accounts start 2.0.0"));
    const outside = st.relay.request({ type: "machine.slots", v: 1, machine: "laptop" });
    go();
    const r = await Promise.race([reloading, new Promise((res) => setTimeout(() => res("завис"), 2000))]);
    expect(r).toMatchObject({ ok: true, result: { modules: { "host-accounts": ["1.0.0", "2.0.0"], "host-slots": ["2.0.0", "3.0.0"] } } });
    expect(log).toEqual(["accounts start 2.0.0", 'slots start 3.0.0 ← accounts {"ok":true,"result":{"v":"2.0.0"}}']);
    expect(await outside).toMatchObject({ ok: true, result: { v: "3.0.0" } });
    expect(st.keeper.readies.at(-1)).toBe("1.4.1");
  });
});

describe("эталоны экосистемы, которые держит ядро", () => {
  it("35 · session.history v1 у chat v2 — contract_mismatch, обработчик не вызван, обе версии в журнале", async () => {
    const history = vi.fn(() => []);
    const st = await stand({ modules: [module("host-chat", { requests: { "session.history": history } }, { provides: { "session.history": 2 } })] });
    await st.open("site@laptop");
    expect(await st.relay.request({ type: "session.history", v: 1, callsign: "site@laptop" })).toMatchObject({ type: "reply", ok: false, error: "contract_mismatch", to: "panel-desk" });
    expect(history).not.toHaveBeenCalled();
    const l = lines(st, "request").at(-1)!;
    expect(l).toMatchObject({ kind: "refuse", who: "core", word: "contract_mismatch", from: "panel-desk", why: "session.history — запрошена v1, у host-chat v2" });
  });

  it("36 · host-budget uses session.cost@host-cost v1, а cost отдаёт v2 — Host не стартует, процессы живы", async () => {
    const k = await new FakeKeeper().listen();
    keepers.push(k);
    const p = k.addProcess("site@laptop");
    const budget = module("host-budget", {}, { uses: { "session.cost@host-cost": 1 } });
    const st = await stand({ keeper: k, sessions: [{ callsign: "site@laptop" }], modules: [budget, cost("2.0.0", [], {}, { "session.cost": 2 })] });
    expect(st.startError?.message).toContain("host-budget: uses session.cost@host-cost v1 — у владельца v2");
    expect(p.alive).toBe(true);
    expect(k.ops).toEqual([]);
  });

  it("37 · stop upgrade посреди команды: session.prompt — shutting_down, stop() модулей, close() не зовётся, выход 0; новый Host — attach, ход дошёл", async () => {
    const k = await new FakeKeeper().listen();
    keepers.push(k);
    const stopped: string[] = [];
    let go!: () => void;
    const later = new Promise<void>((r) => (go = r));
    const chat = module("host-chat", { requests: { "session.prompt": () => "ok" }, stop: async () => { stopped.push("chat"); await later; } });
    const st = await stand({ keeper: k, modules: [chat] });
    await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => st.kernel.sessions.get("site@laptop")!.state === "busy");
    k.stop("upgrade");
    await until(() => !!st.kernel.shutting);
    await until(() => stopped.length === 1);
    expect(await st.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: "x" })).toMatchObject({ ok: false, error: "shutting_down" });
    go();
    await st.kernel.shutting;
    expect(stopped).toEqual(["chat"]);
    expect(st.query("site@laptop").calls).toEqual([]);
    expect(st.exits).toEqual([0]);
    expect(st.relay.clientCloses.at(-1)).toEqual({ code: 1000, reason: "shutting_down" });
    expect(p.alive).toBe(true);
    // команда доработала без Host: вывод копится у keeper
    await until(() => !p.sock);
    p.send(msg.result());
    p.send(msg.state("idle"));
    const got: string[] = [];
    const st2 = await stand({ keeper: k, home: st.home, modules: [module("host-chat", { on: { event: (_s, m) => void got.push(m.type) } })] });
    await until(() => got.includes("result"));
    expect(k.ops.filter((o) => o.id === "site@laptop").map((o) => o.op)).toEqual(["spawn", "attach"]);
    expect(st2.kernel.sessions.get("site@laptop")!.state).toBe("idle");
  });
});
