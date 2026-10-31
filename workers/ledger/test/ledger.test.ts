import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
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
    const out = await j.frame({ type: "ledger.add", v: 1, to: "ledger", from: "@laptop", ev: "slot.swapped", machine: "laptop", text: "слот main: infirex → y0902" });
    expect(out).toEqual([]);
    const [reply] = await j.frame({ type: "ledger.read", id: "r-7", to: "ledger", from: "panel", machine: "laptop", limit: 1 });
    expect(reply).toEqual({
      type: "reply",
      id: "r-7",
      ok: true,
      to: "panel",
      result: { more: false, events: [{ id: 1, t: at("15:02"), ev: "slot.swapped", from: "@laptop", machine: "laptop", text: "слот main: infirex → y0902" }] },
    });
  });

  it("223 · ledger.add без text и machine.left не от ledger — записей нет, две строки bad_frame с from @pc", async () => {
    const j = fresh();
    const log = journal();
    await j.frame({ type: "ledger.add", to: "ledger", from: "@pc", ev: "slot.swapped" });
    await j.frame({ type: "ledger.add", to: "ledger", from: "@pc", ev: "machine.left", machine: "laptop", text: "…" });
    expect(await all(j)).toEqual([]);
    const bad = log.filter((l) => l.word === "bad_frame");
    expect(bad).toHaveLength(2);
    expect(bad.every((l) => l.from === "@pc" && l.part === "ledger" && typeof l.why === "string" && l.why)).toBe(true);
  });

  it("224 · before 5 limit 2 → 4, 3 и more: true; after 3 limit 10 → 5, 4 и more: false", async () => {
    const j = fresh();
    for (let i = 1; i <= 5; i++) await j.frame({ type: "ledger.add", to: "ledger", from: "@pc", ev: "session.opened", text: `s${i}` });
    const [r1] = await j.frame({ type: "ledger.read", id: "r-1", to: "ledger", from: "panel", before: 5, limit: 2 });
    const [r2] = await j.frame({ type: "ledger.read", id: "r-2", to: "ledger", from: "panel", after: 3, limit: 10 });
    const ids = (r: Frame) => (r.result as { events: Array<{ id: number }> }).events.map((e) => e.id);
    expect([ids(r1), (r1.result as { more: boolean }).more]).toEqual([[4, 3], true]);
    expect([ids(r2), (r2.result as { more: boolean }).more]).toEqual([[5, 4], false]);
  });

  it("225 · два session.deleted от points; через 14 дней — те же две записи, будильника нет", async () => {
    const j = fresh();
    clock(at("22:41", "2026-10-30"));
    await j.frame({ type: "ledger.add", to: "ledger", from: "points", ev: "session.deleted", machine: "laptop", by: "panel", text: "old-bot удалена" });
    await j.frame({ type: "ledger.add", to: "ledger", from: "points", ev: "session.deleted", callsign: "wiki@pc", by: "panel", text: "wiki убрана из R2 · 12 точек" });
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
  it("фильтры machine, callsign, q; запись сессии берёт machine из callsign", async () => {
    const j = fresh();
    await j.frame({ type: "ledger.add", to: "ledger", from: "@laptop", ev: "session.opened", callsign: "site@laptop", text: "site@laptop создана" });
    await j.frame({ type: "ledger.add", to: "ledger", from: "@pc", ev: "session.opened", callsign: "docs@pc", text: "docs@pc создана" });
    await j.frame({ type: "ledger.add", to: "ledger", from: "@pc", ev: "machine.upgraded", machine: "pc", text: "pc: Host 1.5.0 → 1.6.0" });
    const read = async (q: Record<string, unknown>) => {
      const [r] = await j.frame({ type: "ledger.read", id: "r", to: "ledger", from: "panel", limit: 10, ...q });
      return (r.result as { events: Array<{ text: string }> }).events.map((e) => e.text);
    };
    expect(await read({ machine: "laptop" })).toEqual(["site@laptop создана"]);
    expect(await read({ machine: "pc" })).toEqual(["pc: Host 1.5.0 → 1.6.0", "docs@pc создана"]);
    expect(await read({ callsign: "docs@pc" })).toEqual(["docs@pc создана"]);
    expect(await read({ q: "Host" })).toEqual(["pc: Host 1.5.0 → 1.6.0"]);
    expect(await read({})).toHaveLength(3);
  });

  it("ledger.read без limit — bad_frame; чужое имя — unknown_request; другая версия — contract_mismatch", async () => {
    const j = fresh();
    expect(await j.frame({ type: "ledger.read", id: "r", to: "ledger", from: "panel" })).toMatchObject([{ ok: false, error: "bad_frame", to: "panel" }]);
    expect(await j.frame({ type: "ledger.drop", id: "r", to: "ledger", from: "panel" })).toMatchObject([{ ok: false, error: "unknown_request" }]);
    expect(await j.frame({ type: "ledger.read", id: "r", v: 2, to: "ledger", from: "panel", limit: 1 })).toMatchObject([{ ok: false, error: "contract_mismatch" }]);
  });

  it("roster не от relay (с from участника) — bad_frame, записей нет", async () => {
    const j = fresh();
    const log = journal();
    await j.frame({ ...roster("laptop"), from: "panel" });
    expect(await all(j)).toEqual([]);
    expect(log).toContainEqual(expect.objectContaining({ word: "bad_frame", from: "panel" }));
  });

  it("выпуск relay: машина ушла и вернулась через 3 с — left и back «не было 3 с»", async () => {
    const j = fresh();
    clock(at("14:44"));
    await j.frame(roster("laptop", "pc"));
    clock(at("14:58") + 1000);
    await j.frame(roster("pc"));
    clock(at("14:58") + 4000);
    await j.frame(roster("pc", "laptop"));
    const rows = await all(j);
    expect(rows.slice(2).map((r) => r.text)).toEqual(["laptop пропала · была на связи с 14:44", "laptop вернулась · не было 3 с"]);
  });

  it("через вход участника: roster без from пишет запись, ledger.read отвечает через RELAY с props ledger", async () => {
    clock(at("09:00", "2026-11-01"));
    await relay.frame(roster("int-machine"));
    await relay.frame({ type: "ledger.read", id: "r-int", to: "ledger", from: "panel", machine: "int-machine", limit: 5 });
    const sent = await env.RELAY_LOG.take();
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe("ledger");
    expect(sent[0].frame).toMatchObject({ type: "reply", id: "r-int", to: "panel", ok: true });
    expect((sent[0].frame.result as { events: Array<{ text: string }> }).events.map((e) => e.text)).toEqual(["int-machine на связи"]);
  });

  it("span: секунды, минуты, часы, дни", () => {
    expect([span(3000), span(42 * 60000), span(125 * 60000), span(3 * 86400000)]).toEqual(["3 с", "42 мин", "2 ч 5 мин", "3 дн"]);
  });
});
