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
  it("host.open: spawn держателя, initialize, idle; hello и session.state в relay", async () => {
    const seen: string[] = [];
    const watch: Module = { on: { event: (_s, m) => void seen.push(m.type) } };
    st = await standHost({ modules: [module("host-watch", watch)] });
    const s = await st.open("site@laptop");
    expect(s.state).toBe("idle");
    expect(s.info.start).toBe("spawn");
    const p = st.proc("site@laptop");
    expect(p.env.DISABLE_UPDATES).toBe("1");
    expect(st.holders.ops.some((o) => o.op === "spawn" && o.id === "site@laptop")).toBe(true);
    expect(st.relay.hellos[0]).toMatchObject({ type: "hello", proto: 1, sdk: "0.3.311", key: "host.laptop.k7f3.stand" });
    turn(p);
    await until(() => s.state === "idle" && seen.includes("result"));
    expect(seen).toEqual(["system", "assistant", "result", "system"]);
    expect(st.states("site@laptop").map((f) => f.state)).toEqual(["starting", "idle", "busy", "idle"]);
  });

  it("s.input: сообщение user в очередь ввода — до процесса доходит с priority, отправитель в s.info.from", async () => {
    st = await standHost({ modules: [module("host-chat", {})] });
    const s = await st.open("site@laptop");
    s.input("Собери отчёт", { from: "poe-bot@pc", priority: "next" });
    const p = st.proc("site@laptop");
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0]).toMatchObject({ type: "user", priority: "next", message: { role: "user", content: "Собери отчёт" } });
    expect(s.info.from).toBe("poe-bot@pc");
  });

  it("system/init: модель и session_id — в s.info", async () => {
    st = await standHost({ modules: [module("host-x", {})] });
    const s = await st.open("site@laptop");
    st.proc("site@laptop").send(msg.init(s.info.session_id, "claude-opus-5"));
    await until(() => s.info.model === "claude-opus-5");
  });
});

describe("стенд: отправитель ввода", () => {
  it("314 · отправитель ввода переживает перезапуск Host: у нового Host s.info.from сессии тот же", async () => {
    // источник: принятый дизайн «Host · отправитель» — отправитель последнего ввода в записи сессии на диске
    const holders = new FakeHolders();
    st = await standHost({ machine: "win", holders, modules: [module("host-reader", {})] });
    const s = await st.open("disk-full-1@win");
    s.input("Свободно 2%", { from: "phone~owner@example.com" });
    const { home } = st;
    await st.close();
    st = await standHost({ machine: "win", home, holders, modules: [module("host-reader", {})] });
    await until(() => st!.session("host-reader", "disk-full-1@win")?.state === "idle");
    expect(st.session("host-reader", "disk-full-1@win")!.info.from).toBe("phone~owner@example.com");
    await st.close();
    st = null;
    await holders.close();
  });

  it("запрос модуля этой машины: отправитель — from запроса, иначе машина", async () => {
    const seen: Array<string | undefined> = [];
    const owner: Module = { requests: { who: (_f, ctx) => void seen.push(ctx.from) } };
    st = await standHost({ machine: "win", modules: [module("host-owner", owner, { provides: { who: 1 } })] });
    await st.host("host-owner").request("who", { v: 1, from: "lead@win" });
    await st.host("host-owner").request("who", { v: 1 });
    expect(seen).toEqual(["lead@win", "@win"]);
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

  it("316 · ввод уходит в сессию по порядку; отправитель последнего ввода — в записи ядра на диске; ввод без from его не меняет", async () => {
    // источник: принятый дизайн «Host · отправитель» — отправитель последнего ввода в записи сессии на диске; ввод без from — чьё: код
    st = await standHost({ machine: "win", modules: [module("host-chat", {})] });
    const s = await st.open("docs@win");
    s.input("Почини вход", { from: "lead@win" });
    s.input("Продолжай");
    const p = st.proc("docs@win");
    await until(() => p.inputs.length === 2);
    expect(p.inputs.map((i) => i.message.content)).toEqual(["Почини вход", "Продолжай"]);
    expect(s.info.from).toBe("lead@win");
    const core = JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")) as { sessions: Array<{ callsign: string; from?: string }> };
    expect(core.sessions.find((x) => x.callsign === "docs@win")!.from).toBe("lead@win");
  });
});

describe("стенд: запрос модуля этой машины — ветки ядра", () => {
  it("317 · обработчик владельца упал — module_error, владелец выключен в сессии запроса, причина в журнале", async () => {
    // источник: устав — ошибка модуля: модуль выключен, в roster failed; слово module_error — чьё: код
    const owner: Module = {
      requests: {
        who: () => {
          throw new Error("бах");
        },
      },
    };
    st = await standHost({ machine: "win", modules: [module("host-owner", owner), module("host-caller", {}, { uses: { "who@host-owner": 1 } })] });
    await st.open("docs@win");
    expect(await st.host("host-caller").request("who", { v: 1, callsign: "docs@win" })).toEqual({ ok: false, error: "module_error" });
    await until(() => st!.states("docs@win").at(-1)?.failed?.["host-owner"]);
    expect(st.journal().some((l) => l.ev === "module_failed" && l.module === "host-owner" && String(l.why).includes("бах"))).toBe(true);
  });

  it("318 · Host останавливается — запрос из stop() модуля отклонён shutting_down, владелец не вызван", async () => {
    // источник: устав, штатная остановка — «не принимает новое»; слово shutting_down — чьё: код
    let called = 0;
    let got: unknown;
    let host!: Host;
    const owner: Module = { requests: { who: () => void called++ } };
    const caller: Module = {
      start: (h) => void (host = h),
      stop: async () => void (got = await host.request("who", { v: 1 })),
    };
    st = await standHost({ machine: "win", modules: [module("host-owner", owner), module("host-caller", caller, { uses: { "who@host-owner": 1 } })] });
    await st.close();
    expect(got).toEqual({ ok: false, error: "shutting_down" });
    expect(called).toBe(0);
    expect(st.journal().some((l) => l.ev === "request" && l.word === "shutting_down")).toBe(true);
    st = null;
  });

  it("319 · вход отклонён: версия запроса не та — contract_mismatch, владелец не вызван, причина в журнале", async () => {
    // источник: устав — ошибки словами; слово contract_mismatch — чьё: код
    let called = 0;
    const owner: Module = { requests: { who: () => void called++ } };
    st = await standHost({ machine: "win", modules: [module("host-owner", owner), module("host-caller", {}, { uses: { "who@host-owner": 1 } })] });
    expect(await st.host("host-caller").request("who", { v: 2 })).toEqual({ ok: false, error: "contract_mismatch" });
    expect(called).toBe(0);
    expect(st.journal().some((l) => l.ev === "request" && l.word === "contract_mismatch")).toBe(true);
  });
});
