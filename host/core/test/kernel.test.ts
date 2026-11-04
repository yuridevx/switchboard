// Эталоны ядра Host по плану цикла host-core (700–737): поддельные SDK, relay, держатели; номер эталона — номер теста.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { content, isRefusal, refuse } from "../contract.ts";
import type { Host } from "../contract.ts";
import { Kernel } from "../src/kernel.ts";
import { realHolders } from "../src/holders.ts";
import { claudeCli } from "../src/release.ts";
import { CORE, FakeHolders, FakeSdk, msg, module, standHost, until } from "../stand/index.ts";
import type { FakeProc, Stand } from "../stand/index.ts";

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
  for (const st of stands.splice(0)) await st.close();
  for (const k of keepers.splice(0)) await k.close();
  for (const p of procs.splice(0)) await p.close();
});

const lines = (st: Stand, ev?: string) => st.journal().filter((l) => !ev || l.ev === ev);
const core = (st: Stand) => (JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")) as { sessions: Array<Record<string, unknown>> }).sessions;
const CS = "site@laptop";

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

  it("715 · держатель не поднялся (нет SWITCHBOARD_HOLDER) — open отказан, второй сбой — failed, причина держателя в журнале", async () => {
    // источник: устав «процесс claude умер — один resume, второй сбой до готовности — failed»
    const home = mkdtempSync(join(tmpdir(), "switchboard-core-"));
    const sdk = new FakeSdk();
    const k = new Kernel({ home, config: { machine: "laptop" }, core: CORE, release: { version: "1", sdk: sdk.version, modules: [], workers: {} }, sdk, holders: realHolders(home, undefined) });
    await k.start();
    await expect(k.open({ callsign: CS, cwd: home })).rejects.toThrow("процесс вышел до initialize");
    await until(() => k.sessions.get(CS)!.state === "failed");
    const dir = join(home, "journal");
    const j = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    const exited = j.filter((l) => l.ev === "session_exited");
    expect(exited).toHaveLength(2);
    expect(exited[0].why).toContain("держатель: нет SWITCHBOARD_HOLDER");
    expect(j.filter((l) => l.ev === "session_failed")).toHaveLength(1);
    await k.shutdown("конец");
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
    expect((e as Error).message).toContain("a.zip");
  });

  it("737 · команда claude: claude нет в пакете SDK — code null со словами", async () => {
    // источник: устав «ошибки — словами»; слово — чьё: код
    expect(await claudeCli(undefined)(["--version"], {})).toEqual({ code: null, out: "claude не найден в пакете SDK" });
  });
});
