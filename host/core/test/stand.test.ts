// Интеграция на стенде: ядро, поддельные держатели по TCP, поддельный SDK и relay.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHolders, msg, module, standHost, turn, until } from "../stand/index.ts";
import type { Stand } from "../stand/index.ts";
import type { Host, Module } from "../contract.ts";

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
