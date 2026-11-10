import { afterEach, describe, expect, it } from "vitest";
import { Refusal } from "@sb/protocol";
import type { Module } from "../src/core/contract.ts";
import { make as chat } from "../src/modules/chat/chat.ts";
import { FakeHolders, stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

describe("ядро Host", () => {
  it("открытие: документ в хранилище, процесс у держателя, строка в картине, сервер инструментов флота с позывным", async () => {
    st = await stand();
    const { s, proc, q } = await st.open("site", { model: "claude-fable-5-2" });
    expect(s.state).toBe("idle");
    expect(proc.alive).toBe(true);
    const opts = q.options as Record<string, any>;
    expect(opts.model).toBe("claude-fable-5-2");
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.mcpServers.fleet).toEqual({ type: "http", url: "https://fleet.test/mcp", headers: { Authorization: "Bearer home:k00001:0123456789abcdef0123", "x-sb-as": "site@laptop" } });
    expect(opts.systemPrompt.append).toContain("site@laptop");
    expect(opts.env.DISABLE_UPDATES).toBe("1");
    const last = st.link.rows("site@laptop").at(-1)!;
    expect(last.row).toMatchObject({ callsign: "site@laptop", state: "idle", by: "pult~yuri@example.com", spec: { name: "site", model: "claude-fable-5-2" } });
    expect(st.kernel.disk.records()[0]).toMatchObject({ callsign: "site@laptop", spec: { name: "site" } });
  });

  it("подключение: снимок machine.hello со строками сессий", async () => {
    st = await stand();
    await st.open("site");
    st.link.drop();
    st.link.open();
    const hello = st.link.of("machine.hello").at(-1)!;
    expect(hello).toMatchObject({ build: 1, sdk: "0.3.321" });
    expect((hello.sessions as any[]).map((r) => r.callsign)).toEqual(["site@laptop"]);
  });

  it("документ: негодный ключ отказан хозяином, документ цел", async () => {
    const owner: Module = {
      name: "host-accounts",
      spec: {
        slot(v) {
          if (v !== "main" && v !== "work") throw new Refusal("unknown_account", `очереди ${String(v)} нет`);
        },
      },
    };
    st = await stand({ modules: [owner] });
    const { s } = await st.open("site", { slot: "main" });
    const bad = await st.request("session.update", { to: "site@laptop", patch: { slot: "nope", effort: "high" } });
    expect(bad).toMatchObject({ ok: false, error: "unknown_account" });
    expect(s.rec.spec).toMatchObject({ slot: "main" });
    expect(s.rec.spec.effort).toBeUndefined();
    const good = await st.request("session.update", { to: "site@laptop", patch: { slot: "work", effort: "high" } });
    expect(good.ok).toBe(true);
    expect(s.rec.spec).toMatchObject({ slot: "work", effort: "high" });
    expect(st.sdk.last("site@laptop")!.calls.map((c) => c.name)).toContain("applyFlagSettings");
    expect(st.link.rows("site@laptop").at(-1)!.row).toMatchObject({ spec: { slot: "work", effort: "high" } });
  });

  it("неназванный ключ документа ставит его хозяин: значение записано в документ; хозяин отказал — сессия не открыта", async () => {
    let only: string | undefined = "main";
    const owner: Module = { name: "host-accounts", spec: { slot() {} }, fill: { slot: () => { if (!only) throw new Refusal("slot_required", "назовите очередь"); return only; } } };
    st = await stand({ modules: [owner] });
    const { s } = await st.open("site");
    expect(s.rec.spec.slot).toBe("main");
    expect((await st.open("named", { slot: "review" })).s.rec.spec.slot).toBe("review");
    only = undefined;
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "x", cwd: st.dir } })).toMatchObject({ ok: false, error: "slot_required" });
    expect(st.kernel.sessions.has("x@laptop")).toBe(false);
  });

  it("у ключа документа и у запроса один хозяин: два — Host не стартует", async () => {
    const a: Module = { name: "a", spec: { slot() {} } };
    const b: Module = { name: "b", spec: { slot() {} }, requests: { "session.open": () => ({}) } };
    st = await stand({ modules: [a, b] });
    expect(st.error?.reasons.join("\n")).toMatch(/ключ документа slot: два хозяина — a и b/);
    expect(st.error?.reasons.join("\n")).toMatch(/запрос session.open: два хозяина — host и b/);
  });

  it("процесс умер — один resume; второй сбой до готовности — failed с причиной в строке", async () => {
    st = await stand();
    const { s, proc } = await st.open("site");
    proc.exit(1, "упал");
    await until(() => st!.holders.spawns.length === 2 && s.state === "idle", 5000, "resume");
    expect(st.sdk.of("site@laptop")).toHaveLength(2);
    expect((st.sdk.last("site@laptop")!.options as any).resume).toBe(s.rec.sessionId);
    // снова упал, и новый процесс не дошёл до готовности — второй сбой подряд
    st.holders.failInitNext = 1;
    st.holders.procs.get("site@laptop")!.exit(1, "упал снова");
    await until(() => st!.holders.procs.get("site@laptop")?.failInit, 5000, "неготовый процесс");
    st.holders.procs.get("site@laptop")!.exit(1, "не поднялся");
    await until(() => s.state === "failed", 5000, "failed");
    expect(st.link.rows("site@laptop").at(-1)!.row).toMatchObject({ state: "failed", error: expect.stringContaining("второй сбой до готовности") });
    expect(st.holders.spawns).toHaveLength(3);
  });

  it("подмена Host: процессы те же, новый Host подключается к держателю", async () => {
    const holders = new FakeHolders();
    const first = await stand({ holders });
    const { proc, s } = await first.open("site");
    const sessionId = s.rec.sessionId;
    await first.kernel.shutdown("подмена");
    expect(proc.alive).toBe(true);
    st = await stand({ holders, home: first.home });
    const again = st.kernel.sessions.get("site@laptop")!;
    await until(() => again.state === "idle", 5000, "attach");
    expect(st.holders.procs.get("site@laptop")).toBe(proc);
    expect(proc.initializes).toBe(2);
    expect(holders.spawns).toHaveLength(1);
    expect(holders.ops.filter((o) => o.op === "attach")).toHaveLength(2);
    expect((st.sdk.last("site@laptop")!.options as any).resume).toBe(sessionId);
  });

  it("ошибка обработчика — module_failed и строка журнала; следующий запрос обслужен", async () => {
    let n = 0;
    const m: Module = {
      name: "host-shell",
      requests: {
        "shell.info"() {
          if (n++ === 0) throw new Error("сломалось");
          return { os: "linux", shells: ["bash"], home: "/home/u" };
        },
      },
    };
    st = await stand({ modules: [m] });
    const bad = await st.request("shell.info", { to: "@laptop" });
    expect(bad).toMatchObject({ ok: false, error: "module_failed" });
    const good = await st.request("shell.info", { to: "@laptop" });
    expect(good).toMatchObject({ ok: true, result: { os: "linux" } });
    expect(st.journal().some((l) => l.level === "error" && l.word === "module_failed" && l.module === "host-shell")).toBe(true);
  });

  it("запрос неизвестного имени — unknown_request; негодный ввод — bad_input; чужая сессия — not_found", async () => {
    st = await stand();
    expect(await st.request("nope.nope", {})).toMatchObject({ ok: false, error: "unknown_request" });
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "x" } })).toMatchObject({ ok: false, error: "bad_input" });
    expect(await st.request("session.stop", { to: "ghost@laptop" })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("на каждый запрос — строка журнала с trace и отрезок host в ответе", async () => {
    st = await stand();
    const r = await st.request("session.stop", { to: "ghost@laptop" });
    expect(r.spans).toEqual([{ part: "host", ms: expect.any(Number) }]);
    expect(r.trace).toMatch(/^t/);
    const line = st.journal().find((l) => l.msg === "request" && l.trace === r.trace)!;
    expect(line).toMatchObject({ part: "host", type: "session.stop", ok: false, word: "not_found", from: "pult~yuri@example.com", machine: "laptop" });
  });

  it("итог хода дочерней сессии уходит родителю кадром message", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("lead");
    // дочь открыта сессией lead: parent ставит ядро, первое сообщение — задача от родителя
    const r = await st.request("session.open", { to: "@laptop", spec: { name: "kid", cwd: st.dir }, prompt: "проверь тесты" }, "lead@laptop");
    expect(r.ok).toBe(true);
    const kid = st.kernel.sessions.get("kid@laptop")!;
    expect(kid.rec.spec.parent).toBe("lead@laptop");
    await until(() => st!.proc("kid@laptop").inputs.length === 1, 5000, "задача дошла");
    await st.turn("kid@laptop", [], "тесты зелёные");
    await until(() => st!.proc("lead@laptop").inputs.length === 1, 5000, "итог у родителя");
    expect(st.proc("lead@laptop").inputs[0]!.message.content).toBe('<fleet-message from="kid@laptop">\nтесты зелёные\n</fleet-message>');
    // ход, начатый человеком, родителю не уходит
    await st.request("message", { to: "kid@laptop", text: "а теперь линтер" });
    await st.turn("kid@laptop", [], "линтер чист");
    await tick(20);
    expect(st.proc("lead@laptop").inputs).toHaveLength(1);
  });

  it("пара: стоп и удаление ведущего уносят ведомого", async () => {
    st = await stand();
    await st.open("wing");
    const { s } = await st.open("lead", { wing: "wing@laptop" });
    expect((await st.request("session.stop", { to: "lead@laptop" })).ok).toBe(true);
    expect(st.kernel.sessions.get("wing@laptop")!.state).toBe("stopped");
    expect(s.state).toBe("stopped");
    expect((await st.request("session.remove", { to: "lead@laptop" })).ok).toBe(true);
    expect([...st.kernel.sessions.keys()]).toEqual([]);
    expect(st.link.rows("wing@laptop").at(-1)!.row).toBeNull();
  });

  it("session.call: метод договора идёт в SDK; у остановленной — отказ stopped", async () => {
    st = await stand();
    await st.open("site");
    expect((await st.request("session.call", { to: "site@laptop", method: "contextUsage" })).ok).toBe(true);
    expect(st.sdk.last("site@laptop")!.calls.at(-1)!.name).toBe("getContextUsage");
    await st.request("session.stop", { to: "site@laptop" });
    expect(await st.request("session.call", { to: "site@laptop", method: "interrupt" })).toMatchObject({ ok: false, error: "stopped" });
  });

  it("запрос сессии другой машины уходит в соединение и ждёт ответ", async () => {
    st = await stand();
    st.link.answers["session.stop"] = (f) => ({ type: "reply", id: f.id!, ok: true, result: {} });
    const { sessionStop } = await import("@sb/protocol");
    await expect(st.kernel.call(sessionStop, { to: "docs@server" })).resolves.toEqual({});
    expect(st.link.of("session.stop")[0]).toMatchObject({ to: "docs@server", from: "@laptop" });
  });

  it("штатная остановка: процессы остаются у держателей, выход 0", async () => {
    st = await stand();
    const { proc } = await st.open("site");
    await st.kernel.shutdown("SIGTERM");
    expect(st.exits).toEqual([0]);
    expect(proc.alive).toBe(true);
    expect(await st.request("session.stop", { to: "site@laptop" })).toMatchObject({ ok: false, error: "shutting_down" });
  });
});
