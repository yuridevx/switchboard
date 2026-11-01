// Интеграция на стенде: ядро, поддельные держатели по TCP, поддельный SDK и relay.
import { afterEach, describe, expect, it } from "vitest";
import { msg, module, standHost, turn, until } from "../stand/index.ts";
import type { Stand } from "../stand/index.ts";
import type { Module } from "../contract.ts";

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
