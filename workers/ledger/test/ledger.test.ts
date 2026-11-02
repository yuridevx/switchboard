import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import { frame, span } from "../src/journal.ts";
import type { Env } from "../src/env.ts";

const relay = (exports as unknown as { default: { hello(): Promise<unknown>; frame(f: Frame): Promise<Frame[]> } }).default;
const at = (hm: string, day = "2026-10-31") => new Date(`${day}T${hm}:00Z`).getTime();
const clock = (t: number) => vi.setSystemTime(t);

const E = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
/** Журнал на тест: база D1 стенда, пустая к началу теста. */
const fresh = () => ({ frame: (f: Frame) => frame(E, f) });

/** Вход или уход машины — ledger.add от relay её машины, без текста. */
const presence = (ev: "machine.back" | "machine.left", machine: string, from = ".relay"): Frame => ({ type: "ledger.add", v: 1, to: ".ledger", from, ev, machine });

async function all(_j?: unknown) {
  return (await E.DB.prepare("SELECT * FROM events ORDER BY id").all<Record<string, unknown>>()).results;
}

function journal() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => {
    lines.push(JSON.parse(String(s)));
  });
  return lines;
}

beforeEach(async () => {
  await applyD1Migrations(E.DB, E.TEST_MIGRATIONS);
  // номера записей с 1 в каждом тесте: курсор — номер записи
  await E.DB.batch([E.DB.prepare("DELETE FROM events"), E.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'")]);
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("эталоны ledger", () => {
  it("5061 · machine.back от relay → «на связи», затем «не было 42 мин» по последней machine.left этой машины; от других — bad_frame, записи нет", async () => {
    const j = fresh();
    clock(at("14:00"));
    await j.frame(presence("machine.back", "laptop"));
    await j.frame(presence("machine.back", "pc"));
    clock(at("14:02"));
    await j.frame(presence("machine.left", "laptop"));
    clock(at("14:44"));
    await j.frame(presence("machine.back", "laptop"));
    expect(await j.frame({ ...presence("machine.back", "pc", "@pc"), id: "x-1" })).toMatchObject([{ ok: false, error: "bad_frame", to: "@pc" }]);
    const rows = await all(j);
    expect(rows.map((r) => [r.ev, r.machine, r.t, r.from])).toEqual([
      ["machine.back", "laptop", at("14:00"), ".relay"],
      ["machine.back", "pc", at("14:00"), ".relay"],
      ["machine.left", "laptop", at("14:02"), ".relay"],
      ["machine.back", "laptop", at("14:44"), ".relay"],
    ]);
    expect(rows.map((r) => r.text)).toEqual(["laptop на связи", "pc на связи", "laptop пропала · была на связи с 14:00", "laptop вернулась · не было 42 мин"]);
  });

  it("221 · 5062 · хранилище — база журнала: ledger.add, затем ledger.read на новом входе Worker'а — запись на месте; объекта нет", async () => {
    clock(at("14:00"));
    await relay.frame(presence("machine.back", "laptop"));
    const [r] = await relay.frame({ type: "ledger.read", v: 1, id: "r", to: ".ledger", from: "panel", machine: "laptop", limit: 5 });
    expect((r.result as { events: Array<{ text: string }> }).events.map((e) => e.text)).toEqual(["laptop на связи"]);
    expect((env as unknown as Record<string, unknown>).JOURNAL).toBeUndefined();
  });

  it("222 · ledger.add без id от @laptop: ответа нет; ledger.read отдаёт запись с from @laptop, t — часы ledger, без by", async () => {
    const j = fresh();
    clock(at("15:02"));
    const out = await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@laptop", ev: "slot.swapped", machine: "laptop", text: "слот main: infirex → y0902" });
    expect(out).toEqual([]);
    const [reply] = await j.frame({ type: "ledger.read", v: 1, id: "r-7", to: ".ledger", from: "panel", machine: "laptop", limit: 1 });
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
    expect(await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@pc", ev: "slot.swapped" })).toEqual([]);
    expect(await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@pc", text: "без ev" })).toEqual([]);
    expect(await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@pc", ev: "machine.left", machine: "laptop", text: "…" })).toEqual([]);
    expect(await j.frame({ type: "ledger.add", v: 1, id: "a-1", to: ".ledger", from: "@pc", ev: "machine.back", text: "…" })).toMatchObject([
      { type: "reply", id: "a-1", ok: false, error: "bad_frame", to: "@pc" },
    ]);
    expect(await all(j)).toEqual([]);
    const bad = log.filter((l) => l.word === "bad_frame");
    expect(bad).toHaveLength(4);
    expect(bad.every((l) => l.from === "@pc" && l.part === "ledger" && typeof l.why === "string" && l.why)).toBe(true);
  });

  it("224 · before 5 limit 2 → 4, 3 и more: true; after 3 limit 10 → 5, 4 и more: false", async () => {
    const j = fresh();
    for (let i = 1; i <= 5; i++) await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@pc", ev: "session.opened", text: `s${i}` });
    const [r1] = await j.frame({ type: "ledger.read", v: 1, id: "r-1", to: ".ledger", from: "panel", before: 5, limit: 2 });
    const [r2] = await j.frame({ type: "ledger.read", v: 1, id: "r-2", to: ".ledger", from: "panel", after: 3, limit: 10 });
    const ids = (r: Frame) => (r.result as { events: Array<{ id: number }> }).events.map((e) => e.id);
    expect([ids(r1), (r1.result as { more: boolean }).more]).toEqual([[4, 3], true]);
    expect([ids(r2), (r2.result as { more: boolean }).more]).toEqual([[5, 4], false]);
  });

  it("2091 · фильтр машины со страницами назад и вперёд — только её записи, more — по её записям", async () => {
    // источник: чьё: код (пульт шлёт machine вместе с before/after)
    const j = fresh();
    for (let i = 1; i <= 6; i++) await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: i % 2 ? "@pc" : "@laptop", ev: "session.opened", machine: i % 2 ? "pc" : "laptop", text: `s${i}` });
    const ids = (r: Frame) => (r.result as { events: Array<{ id: number }> }).events.map((e) => e.id);
    const [r1] = await j.frame({ type: "ledger.read", v: 1, id: "r-1", to: ".ledger", from: "panel", machine: "pc", before: 6, limit: 2 });
    const [r2] = await j.frame({ type: "ledger.read", v: 1, id: "r-2", to: ".ledger", from: "panel", machine: "pc", after: 1, limit: 10 });
    expect([ids(r1), (r1.result as { more: boolean }).more]).toEqual([[5, 3], true]);
    expect([ids(r2), (r2.result as { more: boolean }).more]).toEqual([[5, 3], false]);
  });

  it("225 · два session.deleted от points; через 14 дней — те же две записи, будильника нет", async () => {
    const j = fresh();
    clock(at("22:41", "2026-10-30"));
    await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "points", ev: "session.deleted", machine: "laptop", by: "panel", text: "old-bot удалена" });
    await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "points", ev: "session.deleted", callsign: "wiki@pc", by: "panel", text: "wiki убрана из R2 · 12 точек" });
    clock(at("22:41", "2026-11-13"));
    const rows = await all(j);
    expect(rows.map((r) => [r.ev, r.by, r.machine])).toEqual([
      ["session.deleted", "panel", "laptop"],
      ["session.deleted", "panel", "pc"],
    ]);
  });

});

describe("ledger: чтение, отказы и стык с relay", () => {
  it("фильтр machine; запись сессии берёт machine из callsign", async () => {
    const j = fresh();
    await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@laptop", ev: "session.opened", callsign: "site@laptop", text: "site@laptop создана" });
    await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@pc", ev: "session.opened", callsign: "docs@pc", text: "docs@pc создана" });
    await j.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@pc", ev: "machine.upgraded", machine: "pc", text: "pc: Host 1.5.0 → 1.6.0" });
    const read = async (q: Record<string, unknown>) => {
      const [r] = await j.frame({ type: "ledger.read", v: 1, id: "r", to: ".ledger", from: "panel", limit: 10, ...q });
      return (r.result as { events: Array<{ text: string }> }).events.map((e) => e.text);
    };
    expect(await read({ machine: "laptop" })).toEqual(["site@laptop создана"]);
    expect(await read({ machine: "pc" })).toEqual(["pc: Host 1.5.0 → 1.6.0", "docs@pc создана"]);
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
    expect(await j.frame({ type: "ledger.read", v: 1, to: ".ledger", from: "panel", limit: 5 })).toEqual([]);
    expect(log).toContainEqual(expect.objectContaining({ kind: "refuse", word: "bad_frame", from: "panel" }));
    for (const limit of [undefined, 0, "5", 1.5]) {
      expect(await j.frame({ type: "ledger.read", v: 1, id: "r", to: ".ledger", from: "panel", limit })).toMatchObject([{ id: "r", ok: false, error: "bad_frame", to: "panel" }]);
    }
  });

  it("2010 · через вход участника: ответ только на ledger.read — кадром ответа вызова; на ledger.add кадров нет", async () => {
    clock(at("09:00", "2026-11-01"));
    expect(await relay.frame(presence("machine.back", "int-machine"))).toEqual([]);
    expect(await relay.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@int-machine", ev: "session.opened", machine: "int-machine", text: "s" })).toEqual([]);
    const sent = await relay.frame({ type: "ledger.read", v: 1, id: "r-int", to: ".ledger", from: "panel", machine: "int-machine", limit: 5 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "reply", id: "r-int", to: "panel", ok: true });
    expect((sent[0].result as { events: Array<{ text: string }> }).events.map((e) => e.text)).toEqual(["s", "int-machine на связи"]);
  });

  it("5044 · вызов по привязке → from тот, что поставил вызывающий: .points и .releases пишут по своей привязке", async () => {
    clock(at("10:00", "2026-11-02"));
    await relay.frame({ type: "ledger.add", v: 1, to: ".ledger", from: ".points", ev: "session.deleted", machine: "b-machine", text: "p" });
    await relay.frame({ type: "ledger.add", v: 1, to: ".ledger", from: ".releases", ev: "part.deployed", machine: "b-machine", text: "r" });
    const [r] = await relay.frame({ type: "ledger.read", v: 1, id: "r", to: ".ledger", from: "panel", machine: "b-machine", limit: 5 });
    expect((r.result as { events: Array<{ from: string }> }).events.map((e) => e.from)).toEqual([".releases", ".points"]);
  });

  it("span: секунды, минуты, часы, дни", () => {
    expect([span(3000), span(42 * 60000), span(125 * 60000), span(3 * 86400000)]).toEqual(["3 с", "42 мин", "2 ч 5 мин", "3 дн"]);
  });
});
