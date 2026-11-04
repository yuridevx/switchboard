// Эталон E13: слот в инструментах агента. Поддельные session.open и session.slot — и на своей машине, и через relay.
import { afterEach, describe, expect, it, vi } from "vitest";
import { refuse, stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../src/fleet.ts";
import chatManifest from "../../chat/module.json" with { type: "json" };
import { make as makeChat } from "../../chat/contract.ts";

const { module, standHost } = stand;
const stands: stand.Stand[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stands.splice(0)) await s.close();
});

const WHY = "Слоты машины: main (ждёт сброса 14:30), bot";

type Seen = Array<[string, Record<string, unknown>]>;

async function bench(serve: (f: Frame) => Record<string, unknown> | undefined = () => undefined) {
  const seen: Seen = [];
  let slotReply: () => unknown = () => ({ restart: false });
  let openReply: (r: Record<string, unknown>) => unknown = (r) => ({ callsign: `${r.name}@win`, session_id: "s", slot: "main" });
  const f = make();
  const manage = module(
    "host-manage",
    {
      requests: {
        "session.open": (r) => (seen.push(["session.open", r]), openReply(r) as never),
        "session.update": (r) => (seen.push(["session.update", r]), { now: ["model"] }),
        "session.remove": () => ({}),
      },
      fields: { parent: () => undefined, mode: () => undefined },
    },
    { provides: { "session.open": 1, "session.update": 1, "session.remove": 1, parent: 1, mode: 1 } },
  );
  const logins = module("host-logins", { requests: { "session.slot": (r) => (seen.push(["session.slot", r]), slotReply() as never) } }, { provides: { "session.slot": 1 } });
  const st = await standHost({ machine: "win", modules: [manage, logins, { manifest: chatManifest as Manifest, module: makeChat() }, { manifest: manifest as Manifest, module: f.module }] });
  stands.push(st);
  const recv = st.relay.receive.bind(st.relay);
  st.relay.receive = (ws, text) => {
    recv(ws, text);
    if (text === "ping") return;
    const x = JSON.parse(text) as Frame;
    if (x.type === "hello" || x.type === "reply" || typeof x.id !== "string") return;
    const r = serve(x);
    if (r) queueMicrotask(() => st.relay.deliver({ type: "reply", id: x.id as string, from: "@wsl", ...r } as Frame));
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = f.tools("lead@win").find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0].text };
  };
  return { st, call, seen, setSlot: (fn: () => unknown) => (slotReply = fn), setOpen: (fn: (r: Record<string, unknown>) => unknown) => (openReply = fn) };
}

const OPEN = { name: "job", dir: "~", text: "задача" };

describe("E13 · слот в инструментах агента", () => {
  it("open без slot: поля нет, слот выбрала машина — он в ответе", async () => {
    // источник: факт, отчёт об ошибке: у инструмента не было слота; слово пользователя 4 нояб.: один слот — сессия встаёт сама
    const { st, call, seen } = await bench();
    await st.open("job@win");
    const r = await call("open", OPEN);
    expect(seen[0][1]).not.toHaveProperty("slot");
    expect(r).toEqual({ isError: false, text: "открыта: job@win · слот main; задача во вводе, итог хода придёт сам" });
  });

  it("open со slot: имя дошло до открытия", async () => {
    const { st, call, seen, setOpen } = await bench();
    await st.open("job@win");
    setOpen((q) => ({ callsign: "job@win", session_id: "s", slot: q.slot }));
    const r = await call("open", { ...OPEN, slot: "bot" });
    expect(seen[0][1]).toMatchObject({ slot: "bot" });
    expect(r.text).toBe("открыта: job@win · слот bot; задача во вводе, итог хода придёт сам");
  });

  it("open без слотов на машине: в ответе слота нет", async () => {
    const { st, call, setOpen } = await bench();
    await st.open("job@win");
    setOpen(() => ({ callsign: "job@win", session_id: "s", slot: null }));
    expect((await call("open", OPEN)).text).toBe("открыта: job@win; задача во вводе, итог хода придёт сам");
  });

  it("отказ открытия на своей машине называет слоты", async () => {
    // источник: слово пользователя 4 нояб.: два слота и больше — отказ со списком; находка архитектора: своя машина теряла why
    const { call, setOpen } = await bench();
    setOpen(() => {
      throw refuse("slot_required", WHY);
    });
    expect(await call("open", OPEN)).toEqual({ isError: true, text: `Не выполнено: job@win — slot_required. ${WHY}` });
  });

  it("отказ открытия через relay называет слоты", async () => {
    const { call } = await bench((f) => (f.type === "session.open" ? { ok: false, error: "slot_required", why: WHY } : undefined));
    expect(await call("open", { ...OPEN, machine: "wsl" })).toEqual({ isError: true, text: `Не выполнено: job@wsl — slot_required. ${WHY}` });
  });

  it("timeout открытия: исход неизвестен, проверь list", async () => {
    // источник: находка архитектора: сессия могла открыться, повтор получит name_taken
    const { call } = await bench((f) => (f.type === "session.open" ? { ok: false, error: "timeout" } : undefined));
    expect(await call("open", { ...OPEN, machine: "wsl" })).toEqual({ isError: true, text: "Не выполнено: job@wsl — timeout: исход неизвестен, проверь list" });
  });

  it("update со slot: перезапуск — текст по ответу модуля", async () => {
    const { st, call, seen, setSlot } = await bench();
    await st.open("old@win");
    setSlot(() => ({ restart: true }));
    expect(await call("update", { callsign: "old@win", slot: "main" })).toEqual({ isError: false, text: "слот main; перезапуск между ходами" });
    expect(seen).toEqual([["session.slot", expect.objectContaining({ callsign: "old@win", slot: "main" })]]);
    setSlot(() => ({ restart: false }));
    expect((await call("update", { callsign: "old@win", slot: "main" })).text).toBe("слот main");
  });

  it("update: слот первым, вместе с моделью; отказ слота не меняет остального", async () => {
    const { st, call, seen, setSlot } = await bench();
    await st.open("old@win");
    expect((await call("update", { callsign: "old@win", slot: "main", model: "haiku" })).text).toBe("слот main; сразу: model");
    expect(seen.map((x) => x[0])).toEqual(["session.slot", "session.update"]);
    seen.length = 0;
    setSlot(() => {
      throw refuse("no_slot", "Слоты машины: main, bot");
    });
    expect(await call("update", { callsign: "old@win", slot: "night", model: "haiku", project: "сайт" })).toEqual({ isError: true, text: "Не выполнено: old@win — no_slot. Слоты машины: main, bot" });
    expect(seen.map((x) => x[0])).toEqual(["session.slot"]);
  });
});
