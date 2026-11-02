import { createExecutionContext, env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import { Participant } from "../src/index.ts";
import { span } from "../src/journal.ts";

const relay = (exports as unknown as { default: { hello(): Promise<unknown>; frame(f: Frame): Promise<void> } }).default;
const at = (hm: string, day = "2026-10-31") => new Date(`${day}T${hm}:00Z`).getTime();
const clock = (t: number) => vi.setSystemTime(t);

let n = 0;
/** Свой объект журнала на тест: пустой SQLite. */
const fresh = () =>
  env.JOURNAL.get(env.JOURNAL.idFromName(`t-${++n}-${Math.random()}`)) as unknown as DurableObjectStub & { frame(f: Frame): Promise<Frame[]> };

const roster = (...machines: Array<string | [string, number]>): Frame => ({
  type: "roster",
  machines: machines.map((m) => (Array.isArray(m) ? { machine: m[0], since: m[1] } : { machine: m, since: 0 })),
  sessions: [],
  clients: [],
  workers: [],
});

async function all(stub: ReturnType<typeof fresh>) {
  return runInDurableObject(stub, (_o, s) => s.storage.sql.exec("SELECT * FROM events ORDER BY id").toArray());
}

function journal() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => {
    lines.push(JSON.parse(String(s)));
  });
  return lines;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await env.RELAY_LOG.take();
  await env.RELAY_LOG.answer();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("эталоны ledger", () => {
  it("220 · по roster: machine.back в 14:00, machine.left laptop в 14:02, machine.back laptop в 14:44 «не было 42 мин»", async () => {
    const j = fresh();
    clock(at("14:00"));
    await j.frame(roster("laptop", "pc"));
    clock(at("14:01"));
    // тот же roster ещё раз — новых записей нет
    await j.frame(roster("laptop", "pc"));
    clock(at("14:02"));
    await j.frame(roster("pc"));
    clock(at("14:44"));
    await j.frame(roster(["laptop", at("14:44")], "pc"));
    const rows = await all(j);
    expect(rows.map((r) => [r.ev, r.machine, r.t, r.from])).toEqual([
      ["machine.back", "laptop", at("14:00"), "ledger"],
      ["machine.back", "pc", at("14:00"), "ledger"],
      ["machine.left", "laptop", at("14:02"), "ledger"],
      ["machine.back", "laptop", at("14:44"), "ledger"],
    ]);
    expect(rows[2].text).toBe("laptop пропала · была на связи с 14:00");
    expect(rows[3].text).toBe("laptop вернулась · не было 42 мин");
  });

  it("221 · перезапуск объекта: первый roster с теми же машинами записей не даёт; кроме events — ни таблиц, ни ключей", async () => {
    const j = fresh();
    clock(at("14:00"));
    await j.frame(roster("laptop", "pc"));
    await evictDurableObject(j);
    clock(at("14:50"));
    await j.frame(roster("laptop", "pc"));
    expect(await all(j)).toHaveLength(2);
    const own = await runInDurableObject(j, async (_o, s) => ({
      tables: s.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((r) => r.name)
        .filter((x) => !x.startsWith("_cf_") && x !== "sqlite_sequence"),
      keys: [...(await s.storage.list()).keys()],
      alarm: await s.storage.getAlarm(),
    }));
    expect(own).toEqual({ tables: ["events"], keys: [], alarm: null });
  });

  it("222 · ledger.add без id от @laptop: ответа нет; ledger.read отдаёт запись с from @laptop, t — часы ledger, без by", async () => {
    const j = fresh();
    clock(at("15:02"));
    const out = await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@laptop", ev: "slot.swapped", machine: "laptop", text: "слот main: infirex → y0902" });
    expect(out).toEqual([]);
    const [reply] = await j.frame({ type: "ledger.read", id: "r-7", to: ".ledger", from: "panel", machine: "laptop", limit: 1 });
    expect(reply).toEqual({
      type: "reply",
      id: "r-7",
      ok: true,
      to: "panel",
      result: { more: false, events: [{ id: 1, t: at("15:02"), ev: "slot.swapped", from: "@laptop", machine: "laptop", text: "слот main: infirex → y0902" }] },
    });
  });

  it("223 · ledger.add без text, без ev и machine.left не от ledger — записей нет, строки bad_frame с from @pc; с id — reply bad_frame", async () => {
    const j = fresh();
    const log = journal();
    expect(await j.frame({ type: "ledger.add", to: ".ledger", from: "@pc", ev: "slot.swapped" })).toEqual([]);
    expect(await j.frame({ type: "ledger.add", to: ".ledger", from: "@pc", text: "без ev" })).toEqual([]);
    expect(await j.frame({ type: "ledger.add", to: ".ledger", from: "@pc", ev: "machine.left", machine: "laptop", text: "…" })).toEqual([]);
    expect(await j.frame({ type: "ledger.add", id: "a-1", to: ".ledger", from: "@pc", ev: "machine.back", text: "…" })).toMatchObject([
      { type: "reply", id: "a-1", ok: false, error: "bad_frame", to: "@pc" },
    ]);
    expect(await all(j)).toEqual([]);
    const bad = log.filter((l) => l.word === "bad_frame");
    expect(bad).toHaveLength(4);
    expect(bad.every((l) => l.from === "@pc" && l.part === "ledger" && typeof l.why === "string" && l.why)).toBe(true);
  });

  it("224 · before 5 limit 2 → 4, 3 и more: true; after 3 limit 10 → 5, 4 и more: false", async () => {
    const j = fresh();
    for (let i = 1; i <= 5; i++) await j.frame({ type: "ledger.add", to: ".ledger", from: "@pc", ev: "session.opened", text: `s${i}` });
    const [r1] = await j.frame({ type: "ledger.read", id: "r-1", to: ".ledger", from: "panel", before: 5, limit: 2 });
    const [r2] = await j.frame({ type: "ledger.read", id: "r-2", to: ".ledger", from: "panel", after: 3, limit: 10 });
    const ids = (r: Frame) => (r.result as { events: Array<{ id: number }> }).events.map((e) => e.id);
    expect([ids(r1), (r1.result as { more: boolean }).more]).toEqual([[4, 3], true]);
    expect([ids(r2), (r2.result as { more: boolean }).more]).toEqual([[5, 4], false]);
  });

  it("2091 · фильтр машины со страницами назад и вперёд — только её записи, more — по её записям", async () => {
    // источник: чьё: код (пульт шлёт machine вместе с before/after)
    const j = fresh();
    for (let i = 1; i <= 6; i++) await j.frame({ type: "ledger.add", to: ".ledger", from: i % 2 ? "@pc" : "@laptop", ev: "session.opened", machine: i % 2 ? "pc" : "laptop", text: `s${i}` });
    const ids = (r: Frame) => (r.result as { events: Array<{ id: number }> }).events.map((e) => e.id);
    const [r1] = await j.frame({ type: "ledger.read", id: "r-1", to: ".ledger", from: "panel", machine: "pc", before: 6, limit: 2 });
    const [r2] = await j.frame({ type: "ledger.read", id: "r-2", to: ".ledger", from: "panel", machine: "pc", after: 1, limit: 10 });
    expect([ids(r1), (r1.result as { more: boolean }).more]).toEqual([[5, 3], true]);
    expect([ids(r2), (r2.result as { more: boolean }).more]).toEqual([[5, 3], false]);
  });

  it("225 · два session.deleted от points; через 14 дней — те же две записи, будильника нет", async () => {
    const j = fresh();
    clock(at("22:41", "2026-10-30"));
    await j.frame({ type: "ledger.add", to: ".ledger", from: "points", ev: "session.deleted", machine: "laptop", by: "panel", text: "old-bot удалена" });
    await j.frame({ type: "ledger.add", to: ".ledger", from: "points", ev: "session.deleted", callsign: "wiki@pc", by: "panel", text: "wiki убрана из R2 · 12 точек" });
    clock(at("22:41", "2026-11-13"));
    await j.frame(roster());
    const rows = await all(j);
    expect(rows.map((r) => [r.ev, r.by, r.machine])).toEqual([
      ["session.deleted", "panel", "laptop"],
      ["session.deleted", "panel", "pc"],
    ]);
    expect(await runInDurableObject(j, (_o, s) => s.storage.getAlarm())).toBeNull();
  });

  it("226 · hello() — контракт и uses roster@relay", async () => {
    expect(await relay.hello()).toEqual({
      contract: { "ledger.add": 1, "ledger.read": 1, "machine.left": 1, "machine.back": 1 },
      uses: { "roster@relay": 1 },
    });
  });
});

describe("ledger: чтение, отказы и стык с relay", () => {
  it("фильтры machine и q; запись сессии берёт machine из callsign", async () => {
    const j = fresh();
    await j.frame({ type: "ledger.add", to: ".ledger", from: "@laptop", ev: "session.opened", callsign: "site@laptop", text: "site@laptop создана" });
    await j.frame({ type: "ledger.add", to: ".ledger", from: "@pc", ev: "session.opened", callsign: "docs@pc", text: "docs@pc создана" });
    await j.frame({ type: "ledger.add", to: ".ledger", from: "@pc", ev: "machine.upgraded", machine: "pc", text: "pc: Host 1.5.0 → 1.6.0" });
    const read = async (q: Record<string, unknown>) => {
      const [r] = await j.frame({ type: "ledger.read", id: "r", to: ".ledger", from: "panel", limit: 10, ...q });
      return (r.result as { events: Array<{ text: string }> }).events.map((e) => e.text);
    };
    expect(await read({ machine: "laptop" })).toEqual(["site@laptop создана"]);
    expect(await read({ machine: "pc" })).toEqual(["pc: Host 1.5.0 → 1.6.0", "docs@pc создана"]);
    expect(await read({ q: "Host" })).toEqual(["pc: Host 1.5.0 → 1.6.0"]);
    expect(await read({})).toHaveLength(3);
  });

  it("2011 · вход отклонён: чужое имя — unknown_request, другая версия — contract_mismatch, reply — только строка note", async () => {
    const j = fresh();
    const log = journal();
    expect(await j.frame({ type: "ledger.drop", id: "r", to: ".ledger", from: "panel" })).toMatchObject([{ ok: false, error: "unknown_request", to: "panel" }]);
    expect(await j.frame({ type: "ledger.read", id: "r", v: 2, to: ".ledger", from: "panel", limit: 1 })).toMatchObject([{ ok: false, error: "contract_mismatch", to: "panel" }]);
    expect(await j.frame({ type: "reply", id: "x", ok: true, to: ".ledger", from: "panel" })).toEqual([]);
    expect(log.map((l) => [l.kind, l.word ?? l.ev])).toEqual([
      ["refuse", "unknown_request"],
      ["refuse", "contract_mismatch"],
      ["note", "reply"],
    ]);
    expect(await all(j)).toEqual([]);
  });

  it("2014 · ledger.read: без id — только строка; limit не целое ≥ 1 — bad_frame", async () => {
    const j = fresh();
    const log = journal();
    expect(await j.frame({ type: "ledger.read", to: ".ledger", from: "panel", limit: 5 })).toEqual([]);
    expect(log).toContainEqual(expect.objectContaining({ kind: "refuse", word: "bad_frame", from: "panel" }));
    for (const limit of [undefined, 0, "5", 1.5]) {
      expect(await j.frame({ type: "ledger.read", id: "r", to: ".ledger", from: "panel", limit })).toMatchObject([{ id: "r", ok: false, error: "bad_frame", to: "panel" }]);
    }
  });

  it("roster не от relay (с from участника) — bad_frame, записей нет", async () => {
    const j = fresh();
    const log = journal();
    await j.frame({ ...roster("laptop"), from: "panel" });
    expect(await all(j)).toEqual([]);
    expect(log).toContainEqual(expect.objectContaining({ word: "bad_frame", from: "panel" }));
  });

  it("2015 · новый Host вытеснил прежний: roster с той же машиной и новым since — журнал без left", async () => {
    // источник: слово пользователя «часть машины, включая Host, умерла — один перезапуск»; чьё: код (journal.ts:97-100)
    const j = fresh();
    clock(at("14:00"));
    await j.frame(roster(["laptop", 1]));
    clock(at("14:05"));
    await j.frame(roster(["laptop", 2]));
    expect((await all(j)).map((r) => [r.ev, r.machine])).toEqual([["machine.back", "laptop"]]);
  });

  it("2010 · через вход участника: ответ только на ledger.read — через RELAY с props ledger; на roster и ledger.add кадров нет", async () => {
    clock(at("09:00", "2026-11-01"));
    await relay.frame(roster("int-machine"));
    await relay.frame({ type: "ledger.add", to: ".ledger", from: "@int-machine", ev: "session.opened", machine: "int-machine", text: "s" });
    expect(await env.RELAY_LOG.take()).toEqual([]);
    await relay.frame({ type: "ledger.read", id: "r-int", to: ".ledger", from: "panel", machine: "int-machine", limit: 5 });
    const sent = await env.RELAY_LOG.take();
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe("ledger");
    expect(sent[0].frame).toMatchObject({ type: "reply", id: "r-int", to: "panel", ok: true });
    expect((sent[0].frame.result as { events: Array<{ text: string }> }).events.map((e) => e.text)).toEqual(["s", "int-machine на связи"]);
  });

  it("2012 · объект журнала бросил — строка stop, вызов участника бросает (relay ответит offline)", async () => {
    const log = journal();
    // сбой в коде объекта журнала: пространство объектов, чей frame бросает
    const broken = { idFromName: () => ({}), get: () => ({ frame: () => Promise.reject(new Error("сбой журнала")) }) };
    const p = new Participant(createExecutionContext(), { ...env, JOURNAL: broken } as never);
    await expect(p.frame({ type: "ledger.read", id: "r", to: ".ledger", from: "panel", limit: 1 })).rejects.toThrow("сбой журнала");
    expect(log).toContainEqual(expect.objectContaining({ part: "ledger", kind: "stop", ev: "ledger.read", from: "panel", why: "Error: сбой журнала" }));
    expect(await env.RELAY_LOG.take()).toEqual([]);
  });

  it("2013 · relay не принял ответ — строка refuse, вызов участника не бросает", async () => {
    const log = journal();
    await env.RELAY_LOG.answer("offline");
    await relay.frame({ type: "ledger.read", id: "r-off", to: ".ledger", from: "panel", limit: 1 });
    expect(log).toContainEqual(expect.objectContaining({ kind: "refuse", ev: "relay", word: "offline", to: "panel", type: "reply" }));
  });

  it("span: секунды, минуты, часы, дни", () => {
    expect([span(3000), span(42 * 60000), span(125 * 60000), span(3 * 86400000)]).toEqual(["3 с", "42 мин", "2 ч 5 мин", "3 дн"]);
  });
});
