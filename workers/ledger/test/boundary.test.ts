// Леса границы «журнал и инциденты», сторона Worker'а ledger. Вход — кадр через вход участника и прямой POST; исход — кадры ответа, строки журнала и таблица events.
// Только входы контракта и наблюдаемый исход. Номер — эталон-источник; без номера — чьё: код.
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";

// вход привязки — Participant (relay, points, releases зовут env.LEDGER.frame); прямой вход — fetch
const { Participant: part, default: worker } = exports as unknown as { Participant: { frame(f: Frame): Promise<Frame[]> }; default: { fetch(r: Request): Promise<Response> } };
const DB = (env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] }).DB;
const at = (hm: string, day = "2026-10-31") => new Date(`${day}T${hm}:00Z`).getTime();
const clock = (t: number) => vi.setSystemTime(t);

type Ev = { id: number; t: number; ev: string; from: string; by?: string; machine?: string; callsign?: string; text: string };
const add = (o: Record<string, unknown>) => part.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@pc", ev: "session.opened", text: "s", ...o });
const presence = (ev: string, machine: string) => add({ from: ".relay", ev, machine, text: undefined });
const read = async (o: Record<string, unknown> = {}) => {
  const [r] = await part.frame({ type: "ledger.read", v: 1, id: "r", to: ".ledger", from: "panel", limit: 10, ...o });
  return r.result as { events: Ev[]; more: boolean };
};
const rows = async () => (await DB.prepare("SELECT * FROM events ORDER BY id").all<Record<string, unknown>>()).results;

function journal() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(JSON.parse(String(s))));
  return lines;
}

beforeEach(async () => {
  await applyD1Migrations(DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  // номера записей с 1 в каждом тесте: курсор — номер записи
  await DB.batch([DB.prepare("DELETE FROM events"), DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'")]);
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("вход и уход машины", () => {
  it("5061 · текст пишет ledger по прежним записям этой машины; запись — от .relay, с machine и часами ledger", async () => {
    clock(at("14:00"));
    await presence("machine.back", "laptop");
    await presence("machine.back", "pc");
    clock(at("14:02"));
    await presence("machine.left", "laptop");
    clock(at("14:44"));
    await presence("machine.back", "laptop");
    expect((await rows()).map((r) => [r.ev, r.machine, r.t, r.from, r.text])).toEqual([
      ["machine.back", "laptop", at("14:00"), ".relay", "laptop на связи"],
      ["machine.back", "pc", at("14:00"), ".relay", "pc на связи"],
      // время в тексте пишет Worker, его часы — UTC; рядом на экране время страницы, поэтому пояс назван
      ["machine.left", "laptop", at("14:02"), ".relay", "laptop пропала · была на связи с 14:00 UTC"],
      ["machine.back", "laptop", at("14:44"), ".relay", "laptop вернулась · не было 42 мин"],
    ]);
  });

  it("первая запись о машине — уход: без «была на связи»; уход за уходом — тоже; вход за входом — «на связи»", async () => {
    clock(at("10:00"));
    await presence("machine.left", "a");
    await presence("machine.left", "a");
    await presence("machine.back", "b");
    await presence("machine.back", "b");
    expect((await rows()).map((r) => r.text)).toEqual(["a пропала", "a пропала", "b на связи", "b на связи"]);
  });

  // пороги единиц — 60 с, 60 мин, 48 ч (чьё: код)
  it.each([
    [59_000, "59 с"],
    [60_000, "1 мин"],
    [60 * 60_000, "1 ч"],
    [125 * 60_000, "2 ч 5 мин"],
    [48 * 3_600_000, "2 дн"],
  ])("сколько не было машины: %d мс — «%s»", async (ms, words) => {
    const t0 = at("10:00");
    clock(t0);
    await presence("machine.left", "a");
    clock(t0 + ms);
    await presence("machine.back", "a");
    expect((await rows()).at(-1)!.text).toBe(`a вернулась · не было ${words}`);
  });
});

describe("запись и чтение", () => {
  it("222 · ledger.add без id: ответа нет; чтение — запись целиком: from — адрес отправителя, t — часы ledger, by нет", async () => {
    clock(at("15:02"));
    expect(await add({ from: "@laptop", ev: "slot.swapped", machine: "laptop", text: "слот main: infirex → y0902" })).toEqual([]);
    const reply = await part.frame({ type: "ledger.read", v: 1, id: "r-7", to: ".ledger", from: "panel", machine: "laptop", limit: 1 });
    expect(reply).toEqual([
      { type: "reply", id: "r-7", ok: true, to: "panel", result: { more: false, events: [{ id: 1, t: at("15:02"), ev: "slot.swapped", from: "@laptop", machine: "laptop", text: "слот main: infirex → y0902" }] } },
    ]);
    // с id — ответ ok: так ledger.add приходит через relay
    expect(await add({ id: "a-1", ev: "x", text: "y" })).toEqual([{ type: "reply", id: "a-1", ok: true, to: "@pc" }]);
  });

  it("225 · 5044 · запись от Worker'а: from — как поставил вызывающий, by и callsign на месте; у записи сессии machine — её машина; machine кадра главнее", async () => {
    await add({ from: ".points", ev: "session.deleted", by: "panel", callsign: "wiki@pc", text: "wiki убрана" });
    await add({ from: ".releases", ev: "part.deployed", machine: "laptop", callsign: "wiki@pc", text: "r" });
    await add({ from: "@pc", ev: "x", text: "без машины" });
    expect((await read()).events).toEqual([
      expect.objectContaining({ id: 3, from: "@pc", text: "без машины" }),
      expect.objectContaining({ id: 2, from: ".releases", machine: "laptop", callsign: "wiki@pc" }),
      expect.objectContaining({ id: 1, from: ".points", by: "panel", machine: "pc", callsign: "wiki@pc" }),
    ]);
    expect((await read()).events[0]).not.toHaveProperty("machine");
    expect((await read()).events[0]).not.toHaveProperty("callsign");
  });

  it("формат базы: одна таблица events, колонки на месте, пустые — NULL (живые данные — контракт)", async () => {
    clock(at("09:00"));
    await add({ from: "@pc", ev: "e", text: "t" });
    expect(await rows()).toEqual([{ id: 1, t: at("09:00"), ev: "e", from: "@pc", by: null, machine: null, callsign: null, text: "t" }]);
  });

  it.each([
    ["224 · назад", { before: 5, limit: 2 }, [4, 3], true],
    ["224 · вперёд, новые сначала", { after: 3, limit: 10 }, [5, 4], false],
  ])("страницы: %s", async (_n, q, ids, more) => {
    for (let i = 1; i <= 5; i++) await add({ text: `s${i}` });
    const r = await read(q);
    expect([r.events.map((e) => e.id), r.more]).toEqual([ids, more]);
  });

  it("2091 · фильтр машины со страницами назад и вперёд: только её записи, more — по её записям", async () => {
    for (let i = 1; i <= 6; i++) await add({ machine: i % 2 ? "pc" : "laptop", text: `s${i}` });
    const page = async (q: Record<string, unknown>) => {
      const r = await read({ machine: "pc", ...q });
      return [r.events.map((e) => e.id), r.more];
    };
    expect(await page({ before: 6, limit: 2 })).toEqual([[5, 3], true]);
    expect(await page({ after: 1, limit: 10 })).toEqual([[5, 3], false]);
  });
});

describe("отказы", () => {
  it.each([
    ["223 · add без ev", { type: "ledger.add", v: 1, text: "t" }, "bad_frame", null],
    ["223 · add без text", { type: "ledger.add", v: 1, ev: "e" }, "bad_frame", null],
    ["add: ev не текст", { type: "ledger.add", v: 1, ev: 5, text: "t" }, "bad_frame", null],
    ["5061 · machine.left не от relay", { type: "ledger.add", v: 1, ev: "machine.left", machine: "a", text: "t" }, "bad_frame", null],
    ["5061 · machine.back не от relay", { type: "ledger.add", v: 1, id: "x", ev: "machine.back", machine: "a" }, "bad_frame", "x"],
    ["машина relay без machine", { type: "ledger.add", v: 1, id: "x", from: ".relay", ev: "machine.back" }, "bad_frame", "x"],
    ["2014 · read без id", { type: "ledger.read", v: 1, limit: 5 }, "bad_frame", null],
    ["2014 · limit нет", { type: "ledger.read", v: 1, id: "x" }, "bad_frame", "x"],
    ["2014 · limit 0", { type: "ledger.read", v: 1, id: "x", limit: 0 }, "bad_frame", "x"],
    ["2011 · чужое имя", { type: "ledger.drop", id: "x" }, "unknown_request", "x"],
  ])("%s: %#j — слово, записей нет, строка журнала с причиной", async (_n, f, word, id) => {
    const log = journal();
    const out = await part.frame({ to: ".ledger", from: "@pc", ...f } as Frame);
    expect(out).toEqual(id ? [expect.objectContaining({ type: "reply", id, ok: false, error: word, to: (f as { from?: string }).from ?? "@pc" })] : []);
    expect(log).toEqual([expect.objectContaining({ part: "ledger", kind: "refuse", word, from: (f as { from?: string }).from ?? "@pc", why: expect.stringMatching(/./) })]);
    expect(await rows()).toEqual([]);
  });

  it("223 · в строке отказа записи — имя записи, текста нет", async () => {
    const log = journal();
    await part.frame({ type: "ledger.add", v: 1, to: ".ledger", from: "@pc", ev: "machine.left", machine: "a", text: "секретный текст" });
    expect(log[0]).toMatchObject({ ev: "ledger.add", rec: "machine.left" });
    expect(JSON.stringify(log[0])).not.toContain("секретный текст");
  });

  it("2011 · кадр reply: ledger ответов не ждёт — строка note, кадров нет", async () => {
    const log = journal();
    expect(await part.frame({ type: "reply", id: "x", ok: true, to: ".ledger", from: "panel" })).toEqual([]);
    expect(log).toEqual([expect.objectContaining({ part: "ledger", kind: "note", ev: "reply", from: "panel" })]);
  });
});

describe("прямой вход", () => {
  const post = (f: Record<string, unknown>) => worker.fetch(new Request("https://ledger.example/", { method: "POST", body: JSON.stringify(f) }));

  it("POST кадра с пропуском: запись от адреса пропуска; чтение — ответ кадром; плохой пропуск — слово, записи нет; не POST — 404", async () => {
    clock(at("12:00"));
    await post({ type: "ledger.add", v: 1, key: "host.laptop.k1.s", ev: "e", text: "прямо" });
    const r = await post({ type: "ledger.read", v: 1, id: "r", key: "client.panel.k2.s", limit: 5 });
    expect(await r.json()).toMatchObject({ type: "reply", id: "r", ok: true, result: { more: false, events: [{ id: 1, t: at("12:00"), ev: "e", from: "@laptop", text: "прямо" }] } });
    const bad = await post({ type: "ledger.add", v: 1, id: "b", key: "host.laptop.k1.bad", ev: "e", text: "нет" });
    expect(await bad.json()).toMatchObject({ ok: false, error: "bad_key" });
    expect(await rows()).toHaveLength(1);
    expect((await worker.fetch(new Request("https://ledger.example/"))).status).toBe(404);
  });
});
