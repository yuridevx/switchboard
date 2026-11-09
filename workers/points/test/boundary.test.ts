// Леса границы «точка сессии», сторона Worker'а: только вход Worker'а — frame по привязке, POST с пропуском, расписание.
// Исход: кадр ответа, строки базы D1 (их формат — контракт), запросы к хранилищу (стенд контракта blocks), строка журнала флота.
// Номер — эталон-источник; без номера — чьё: код.
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import type { BlocksStand } from "@switchboard/blocks";

type Db = { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
const E = env as unknown as Db;
const LEDGER = (env as unknown as { LEDGER: { got(): Promise<Frame[]>; clear(): Promise<void> } }).LEDGER;
const STORE = (env as unknown as { STORE: BlocksStand }).STORE;
const worker = (exports as unknown as { default: { frame(f: Frame): Promise<Frame[]>; fetch(r: Request): Promise<Response>; scheduled(): Promise<void> } }).default;

const DAY = 86_400_000;
const YEAR = 365 * DAY;
// часы теста — в будущем, чтобы настоящие часы не догоняли их посреди прогона
const T0 = Date.UTC(2030, 9, 31, 20, 0);
const clock = (t: number) => vi.setSystemTime(t);
const D = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);

beforeEach(async () => {
  await applyD1Migrations(E.DB, E.TEST_MIGRATIONS);
  await E.DB.batch(["sessions", "points", "blocks", "refs", "meta", "sqlite_sequence"].map((x) => E.DB.prepare(`DELETE FROM ${x}`)));
  await STORE.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Кадр в Worker: ответ, затем строки журнала, которые он отдал по привязке. */
async function send(f: Frame): Promise<Frame[]> {
  await LEDGER.clear();
  const out = await worker.frame(f);
  return [...out, ...(await LEDGER.got()).map(({ from: _f, ...x }) => x as Frame)];
}

/** Уборка расписанием; итог — сколько точек ушло из базы и что записано в обзор. */
async function sweep(): Promise<{ points: number; blocks: number; bytes: number }> {
  const before = await count("SELECT COUNT(*) AS n FROM points");
  await worker.scheduled();
  const [l] = await list();
  const { blocks, bytes } = (l.result as { sweep: { blocks: number; bytes: number } }).sweep;
  return { points: before - (await count("SELECT COUNT(*) AS n FROM points")), blocks, bytes };
}

const list = (sid?: string, extra: Record<string, unknown> = {}) => send({ type: "points.list", v: 2, id: "l", to: ".points", from: "panel", ...(sid ? { sid } : {}), ...extra });
const put = (from: string, sid: string, files: unknown, extra: Record<string, unknown> = {}) =>
  send({ type: "points.put", v: 3, id: "p", to: ".points", from, sid, why: "rule", files, callsign: `site@${from.slice(1)}`, ...extra });
/** Отпечаток блока: короткое имя теста, дополненное до SHA-256 hex. */
const H = (x: string) => x.padEnd(64, "0");
const file = (b: string[], size = 100, p = "s.jsonl") => [{ p, size, b: b.map(H) }];

/** Ссылка стенда хранилища на блок. */
const linkOf = (method: "GET" | "PUT", h: string) => `https://blocks.test/b/${H(h)}?m=${method}`;

/** Блоки «выгружены по ссылке»: лежат в хранилище, размер 10. */
async function inStore(...hashes: string[]) {
  for (const h of hashes) await STORE.put(H(h), 10);
}
/** Сколько запросов дошло до хранилища. */
const storeCalls = async () => (await STORE.got()).length;

const sessionRow = async (sid: string) => (await E.DB.prepare("SELECT owner, head FROM sessions WHERE sid = ?").bind(sid).first()) ?? undefined;
const count = async (q: string, ...args: Array<string | number>) => (await E.DB.prepare(q).bind(...args).first<{ n: number }>())!.n;

/** Строки журнала Worker'а. */
function journal() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((x: unknown) => void lines.push(JSON.parse(String(x))));
  return lines;
}

/** Сессия из k точек хозяина: файлы у каждой свои (size — номер). */
async function line(from: string, sid: string, k: number, b: string[]) {
  const ids: number[] = [];
  for (let i = 1; i <= k; i++) ids.push(((await put(from, sid, file(b, i)))[0].result as { id: number }).id);
  return ids;
}

type Row = { id: number; at: number; base: number | null };
/** Точки в базе напрямую: форма строк — контракт хранилища. */
async function seed(sid: string, head: number, rows: Row[]) {
  await E.DB.batch([
    ...rows.map((r) => E.DB.prepare("INSERT INTO points (id, sid, machine, at, why, base, files) VALUES (?, ?, 'laptop', ?, 'rule', ?, '[]')").bind(r.id, sid, r.at, r.base)),
    E.DB.prepare("INSERT INTO sessions (sid, owner, head) VALUES (?, 'laptop', ?)").bind(sid, head),
  ]);
}
type Listed = { owner: string | null; head: number | null; points: Array<{ id: number; base: number; line: boolean; until: number | null }> };
const lineList = async (sid: string) => (await list(sid))[0].result as Listed;
const untilOf = async (sid: string) => new Map((await lineList(sid)).points.map((p) => [p.id, p.until]));
const ids = async () => (await E.DB.prepare("SELECT id FROM points ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
const sids = async () => ((await list())[0].result as { sessions: Array<{ sid: string }> }).sessions.map((x) => x.sid).sort();

describe("снять точку", () => {
  it("200 · первая точка неизвестной сессии от @laptop: ok { id: 1 }, хозяин laptop, голова 1; строка точки — формат хранилища", async () => {
    await inStore("200a1", "200b7");
    expect(await put("@laptop", "42bc", file(["200a1", "200b7"]), { dir: "~/Projects/site", spec: { model: "opus" }, title: "Перенеси журнал", model: "claude-opus-5-5", tok_in: 3100, tok_out: 88, git: { state: "clean" }, msgs: 3, bytes: 7 })).toEqual([
      { type: "reply", id: "p", ok: true, result: { id: 1 }, to: "@laptop" },
    ]);
    expect(await sessionRow("42bc")).toEqual({ owner: "laptop", head: 1 });
    const row = await E.DB.prepare("SELECT * FROM points").first();
    expect(row).toEqual({ id: 1, sid: "42bc", machine: "laptop", at: T0, why: "rule", base: null, callsign: "site@laptop", dir: "~/Projects/site", msgs: 3, bytes: 7, git: '{"state":"clean"}', files: JSON.stringify(file(["200a1", "200b7"])), spec: '{"model":"opus"}', title: "Перенеси журнал", model: "claude-opus-5-5", tok_in: 3100, tok_out: 88 });
    expect(await count("SELECT COUNT(*) AS n FROM refs WHERE point = 1")).toBe(2);
    expect((await E.DB.prepare("SELECT hash, size FROM blocks ORDER BY hash").all()).results).toEqual([{ hash: H("200a1"), size: 10 }, { hash: H("200b7"), size: 10 }]);
  });

  it("201 · хозяин pc; точка от @laptop с why rule — not_owner { owner: pc }, в хранилище не ходили, строк столько же, голова прежняя", async () => {
    await inStore("201a1");
    await line("@pc", "s201", 2, ["201a1"]);
    const calls = await storeCalls();
    expect(await put("@laptop", "s201", file(["201a1", "201ff"], 99))).toEqual([{ type: "reply", id: "p", ok: false, error: "not_owner", owner: "pc", to: "@laptop" }]);
    expect(await storeCalls()).toBe(calls);
    expect(await count("SELECT COUNT(*) AS n FROM points")).toBe(2);
    expect(await sessionRow("s201")).toEqual({ owner: "pc", head: 2 });
  });

  it("202 2097 40 · блока b7 нет: missing и ссылка PUT хранилища ровно на него; машина выгрузила b7 — второй points.put ok: хранилище отдало его в have; блоки в обзоре", async () => {
    await inStore("202a1");
    await put("@laptop", "s202", file(["202a1"]));
    const first = await put("@laptop", "s202", file(["202a1", "202b7"]));
    expect(first[0]).toMatchObject({ ok: false, error: "missing", missing: [H("202b7")], links: { [H("202b7")]: linkOf("PUT", "202b7") } });
    expect(Object.keys((first[0] as unknown as { links: Record<string, string> }).links)).toEqual([H("202b7")]);
    expect(await count("SELECT COUNT(*) AS n FROM points")).toBe(1);
    await inStore("202b7");
    expect((await put("@laptop", "s202", file(["202a1", "202b7"])))[0]).toMatchObject({ ok: true, result: { id: 2 } });
    // в хранилище спрашивали только то, чего реестр не знал: один links PUT на b7 до выгрузки и один после
    const asked = (await STORE.got()).filter((f) => f.type === "blocks.links").map((f) => f.hashes);
    expect(asked).toEqual([[H("202a1")], [H("202b7")], [H("202b7")]]);
    expect(((await list())[0].result as { store: { blocks: number } }).store.blocks).toBe(2);
  });

  it("203 2066 · файлы те же, что у головы, — same, новой строки нет: у хозяина и у прежнего хозяина, который вернулся без нового", async () => {
    await inStore("203a1");
    expect((await line("@laptop", "s203", 7, ["203a1"])).at(-1)).toBe(7);
    expect(await put("@laptop", "s203", file(["203a1"], 7))).toEqual([{ type: "reply", id: "p", ok: true, result: { id: 7, same: true }, to: "@laptop" }]);
    expect(await count("SELECT COUNT(*) AS n FROM points")).toBe(7);
    await put("@pc", "s203", file(["203a1"], 7), { why: "raise", base: 7, expect: "laptop" });
    const before = await lineList("s203");
    expect(await put("@laptop", "s203", file(["203a1"], 7), { why: "yield" })).toEqual([{ type: "reply", id: "p", ok: true, result: { id: 7, same: true }, to: "@laptop" }]);
    const after = await lineList("s203");
    expect([after.owner, after.head, after.points.length]).toEqual([before.owner, before.head, before.points.length]);
  });
});

describe("подъём и хозяин", () => {
  it("204 · подъём на pc с expect laptop — ok { id: 5 }, хозяин pc, один ledger.add session.moved; mac следом — not_owner { owner: pc }", async () => {
    await inStore("204a1");
    await line("@laptop", "s204", 4, ["204a1"]);
    const pc = await put("@pc", "s204", file(["204a1"], 4), { why: "raise", base: 4, expect: "laptop", by: "panel" });
    expect(pc[0]).toMatchObject({ ok: true, result: { id: 5 }, to: "@pc" });
    expect(pc.filter((x) => x.type === "ledger.add")).toEqual([
      { type: "ledger.add", v: 1, to: ".ledger", ev: "session.moved", text: "site: laptop → pc · из точки 4", machine: "pc", callsign: "site@pc", by: "panel" },
    ]);
    expect(await sessionRow("s204")).toEqual({ owner: "pc", head: 5 });
    expect(await put("@mac", "s204", file(["204a1"], 4), { why: "raise", base: 4, expect: "laptop" })).toEqual([{ type: "reply", id: "p", ok: false, error: "not_owner", owner: "pc", to: "@mac" }]);
  });

  it("205 · вернувшийся pc отдаёт сессию: yield — точка 11 от его 9, хозяин mac, голова 10; в списке у 11 line: false", async () => {
    await inStore("205a1", "205c4");
    await line("@pc", "s205", 9, ["205a1"]);
    expect((await put("@mac", "s205", file(["205a1"], 9), { why: "raise", base: 9, expect: "pc" }))[0]).toMatchObject({ ok: true, result: { id: 10 } });
    expect(await put("@pc", "s205", file(["205a1", "205c4"], 10), { why: "yield" })).toEqual([{ type: "reply", id: "p", ok: true, result: { id: 11 }, to: "@pc" }]);
    expect(await sessionRow("s205")).toEqual({ owner: "mac", head: 10 });
    const pts = (await lineList("s205")).points;
    expect(pts.find((p) => p.id === 11)).toMatchObject({ base: 9, line: false });
    expect(pts.find((p) => p.id === 10)).toMatchObject({ line: true });
  });

  it("2065 · откат на той же машине — голова от base, ledger.add session.rolled_back, ветка «до отката» в списке, срок год; подъём от своей головы — без события", async () => {
    await inStore("302a1");
    await line("@pc", "s302", 4, ["302a1"]);
    const out = await put("@pc", "s302", file(["302a1"], 2), { why: "raise", base: 2, expect: "pc" });
    expect(out[0]).toMatchObject({ ok: true, result: { id: 5 } });
    expect(out.slice(1)).toEqual([expect.objectContaining({ type: "ledger.add", ev: "session.rolled_back", machine: "pc", text: "site@pc откатана к точке 2" })]);
    const r = await lineList("s302");
    expect([r.owner, r.head]).toEqual(["pc", 5]);
    expect(r.points.map((p) => [p.id, p.line])).toEqual([[5, true], [4, false], [3, false], [2, true], [1, true]]);
    expect(r.points[0].until).toBeNull();
    expect(r.points[1].until).toBe(T0 + YEAR);
    const own = await put("@pc", "s302", file(["302a1"], 9), { why: "raise", base: 5, expect: "pc" });
    expect(own).toEqual([expect.objectContaining({ ok: true, result: { id: 6 } })]);
    expect((await lineList("s302")).points.find((x) => x.id === 6)?.base).toBe(5);
  });

  it("2061 · копия — новый sid с base из другой сессии: хозяин — машина копии, исходная цела, session.copied", async () => {
    await inStore("2061a");
    const [p1] = await line("@laptop", "s2061", 1, ["2061a"]);
    const out = await put("@pc", "s2061c", file(["2061a"], 5), { base: p1, callsign: "copy@pc" });
    expect(out[0]).toMatchObject({ ok: true, to: "@pc" });
    expect(out[1]).toEqual({ type: "ledger.add", v: 1, to: ".ledger", ev: "session.copied", text: `site → copy@pc · из точки ${p1}`, machine: "pc", callsign: "copy@pc" });
    const r = await lineList("s2061c");
    expect(r.owner).toBe("pc");
    expect(r.points).toEqual([expect.objectContaining({ id: r.head, base: p1 })]);
    expect(await lineList("s2061")).toMatchObject({ owner: "laptop", head: p1 });
  });

  it.each([["у подъёма", "s2062", { why: "raise", expect: "laptop" }]])("2062 · основы нет — no_point с номером %s", async (_n, sid, extra) => {
    await inStore("2062a");
    await line("@laptop", "s2062", 1, ["2062a"]);
    expect(await put("@pc", sid, file(["2062a"]), { base: 99, ...extra })).toEqual([{ type: "reply", id: "p", ok: false, error: "no_point", ids: [99], to: "@pc" }]);
  });
});

describe("вернуть: points.get и points.list", () => {
  it("2098 · points.get: машине и устройству человека — строки, хозяин и ссылки GET на блоки этих точек и только их; без адреса устройства — без ссылок; нет точки — no_point", async () => {
    await inStore("301a1", "301b2", "302c3");
    await put("@laptop", "s301", file(["301a1", "301b2"]), { dir: "~/Projects/site", spec: { model: "opus" }, title: "Сайт", git: { state: "clean" }, msgs: 3 });
    await put("@laptop", "s302", file(["302c3"]));
    const [m] = await send({ type: "points.get", v: 2, id: "g", to: ".points", from: "@pc", ids: [1] });
    expect(m.result).toMatchObject({
      owner: "laptop",
      points: [{ id: 1, sid: "s301", machine: "laptop", why: "rule", base: null, dir: "~/Projects/site", spec: { model: "opus" }, title: "Сайт", git: { state: "clean" }, msgs: 3, files: file(["301a1", "301b2"]) }],
    });
    expect((m.result as { links: Record<string, string> }).links).toEqual({ [H("301a1")]: linkOf("GET", "301a1"), [H("301b2")]: linkOf("GET", "301b2") });
    const [p] = await send({ type: "points.get", v: 2, id: "g", to: ".points", from: "panel", ids: [1] });
    expect((p.result as Record<string, unknown>).links).toBeUndefined();
    // 35 · устройство человека ходит в хранилище само: switchboard pull берёт ссылки GET
    const [d] = await send({ type: "points.get", v: 2, id: "g", to: ".points", from: "pult~ann@example.com", ids: [1] });
    expect(Object.keys((d.result as { links: Record<string, string> }).links).sort()).toEqual([H("301a1"), H("301b2")]);
    expect(await send({ type: "points.get", v: 2, id: "g", to: ".points", from: "panel", ids: [1, 9] })).toEqual([{ type: "reply", id: "g", ok: false, error: "no_point", ids: [9], to: "panel" }]);
  });

  it("обзор флота: сессии, место в хранилище, итог уборки, умеет ли хранилище искать, ветки — концы без детей, кроме головы; поля без значения не приходят", async () => {
    await inStore("303a1", "303b7");
    await put("@laptop", "s303", file(["303a1", "303b7"]), { dir: "~/x" });
    await sweep();
    expect((await list())[0].result).toEqual({
      search: true,
      sessions: [{ sid: "s303", callsign: "site@laptop", dir: "~/x", owner: "laptop", head: { id: 1, at: T0 }, points: 1, branches: 0 }],
      store: { bytes: 20, blocks: 2 },
      sweep: { at: T0, blocks: 0, bytes: 0 },
    });
    expect((await list("nope"))[0].result).toEqual({ owner: null, head: null, points: [] }); // 2068
    await seed("bare", 52, [
      { id: 50, at: T0 + 1, base: null },
      { id: 51, at: T0 + 2, base: 50 },
      { id: 52, at: T0 + 3, base: 50 },
    ]);
    expect(((await list())[0].result as { sessions: unknown[] }).sessions[0]).toEqual({ sid: "bare", owner: "laptop", head: { id: 52, at: T0 + 3 }, points: 3, branches: 1 });
  });

  it("27 · каталог: заголовок, модель и токены — из последней точки сессии; порядок по токенам; since — сессии с точкой не раньше; limit", async () => {
    await inStore("27a", "27b", "27c");
    clock(T0 - 3 * DAY);
    await put("@laptop", "s27old", file(["27a"]), { title: "Старая", model: "claude-haiku-5-5", tok_in: 900, tok_out: 9 });
    clock(T0);
    await put("@laptop", "s27a", file(["27b"]), { title: "Сначала", model: "claude-sonnet-5-5", tok_in: 10, tok_out: 1 });
    await put("@laptop", "s27a", file(["27b"], 2), { title: "Перенеси журнал", model: "claude-opus-5-5", tok_in: 3100, tok_out: 88 });
    await put("@pc", "s27b", file(["27c"]), { title: "Сайт", model: "claude-opus-5-5", tok_in: 50, tok_out: 5 });
    const rows = async (extra: Record<string, unknown>) => ((await list(undefined, extra))[0].result as { sessions: Array<Record<string, unknown>> }).sessions;
    expect((await rows({ order: "tokens" })).map((x) => [x.sid, x.title, x.model, x.tok_in, x.tok_out])).toEqual([
      ["s27a", "Перенеси журнал", "claude-opus-5-5", 3100, 88],
      ["s27old", "Старая", "claude-haiku-5-5", 900, 9],
      ["s27b", "Сайт", "claude-opus-5-5", 50, 5],
    ]);
    expect((await rows({})).map((x) => x.sid)).toEqual(["s27a", "s27b", "s27old"]);
    expect((await rows({ since: new Date(T0 - DAY).toISOString() })).map((x) => x.sid).sort()).toEqual(["s27a", "s27b"]);
    expect(await rows({ limit: 1 })).toHaveLength(1);
  });

  it("поиск: q — хранилищу только отпечатки блоков файла разговора последних точек; совпадение — запись с uuid, отрывком и точкой; у копии с общим блоком — тоже", async () => {
    const say = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, timestamp: "2030-10-31T20:00:00.000Z", message: { role: "user", content: text } });
    await STORE.put(H("aa"), 10, [say("u1", "перенеси Миграцию D1 в ClickHouse")]);
    await STORE.put(H("bb"), 10, [say("u2", "миграция d1 уже идёт")]);
    await STORE.put(H("c01d"), 10, [say("u0", "миграция d1 в старой точке")]);
    await STORE.put(H("5ab"), 10, [say("u9", "миграция d1 в субагенте")]);
    await put("@laptop", "sq", [{ p: "sq.jsonl", size: 10, b: [H("c01d")] }]);
    await put("@laptop", "sq", [{ p: "sq.jsonl", size: 20, b: [H("aa")] }, { p: "sq/subagents/agent-1.jsonl", size: 10, b: [H("5ab")] }], { title: "Журнал" });
    await put("@pc", "sqc", [{ p: "sqc.jsonl", size: 20, b: [H("aa"), H("bb")] }], { base: 2, callsign: "copy@pc" });
    const r = (await list(undefined, { q: "  Миграцию D1 " }))[0].result as { search: boolean; sessions: Array<{ sid: string; title?: string; hits: unknown[] }> };
    expect(r.search).toBe(true);
    expect(r.sessions.map((x) => [x.sid, x.hits]).sort()).toEqual([
      ["sq", [{ uuid: "u1", point: 2, at: "2030-10-31T20:00:00.000Z", text: "перенеси Миграцию D1 в ClickHouse" }]],
      ["sqc", [{ uuid: "u1", point: 3, at: "2030-10-31T20:00:00.000Z", text: "перенеси Миграцию D1 в ClickHouse" }]],
    ]);
    const asked = (await STORE.got()).filter((f) => f.type === "blocks.search" && f.q);
    expect(asked.map((f) => [f.q, (f.hashes as string[]).sort()])).toEqual([["миграцию d1", [H("aa"), H("bb")].sort()]]);
  });

  it("хранилище без поиска: каталог — search: false; q — отказ no_search", async () => {
    await STORE.searchable(false);
    await inStore("e5");
    await put("@laptop", "sns", [{ p: "sns.jsonl", size: 1, b: [H("e5")] }]);
    expect(((await list())[0].result as { search: boolean; sessions: unknown[] }).search).toBe(false);
    expect((await list(undefined, { q: "слово" }))[0]).toMatchObject({ ok: false, error: "no_search" });
  });

  it("список сессии: точки от новых к старым, без файлов и спецификации", async () => {
    await inStore("304c");
    await put("@laptop", "s304c", file(["304c"]), { spec: { model: "opus" }, msgs: 1, bytes: 2, git: { state: "clean" }, dir: "~/d" });
    await put("@laptop", "s304c", file(["304c"], 2));
    const pts = (await lineList("s304c")).points as unknown as Array<Record<string, unknown>>;
    expect(pts.map((p) => p.id)).toEqual([2, 1]);
    expect(pts[1]).toEqual({ id: 1, machine: "laptop", at: T0, why: "rule", base: null, callsign: "site@laptop", dir: "~/d", msgs: 1, bytes: 2, git: { state: "clean" }, line: true, until: expect.any(Number) });
  });
});

describe("правило хранения: срок в списке и уборка расписанием", () => {
  it("206 · 400 дней по две точки, шесть сегодня, ветка 40 дней назад: уборка оставляет ровно то, что велит правило", async () => {
    const today = Date.UTC(2026, 9, 31);
    const rows: Row[] = [];
    let id = 0;
    for (let d = 399; d >= 0; d--) {
      const hours = d === 0 ? [2, 5, 8, 11, 14, 17] : [10, 18];
      for (const h of hours) rows.push({ id: ++id, at: today - d * DAY + h * 3600_000, base: id > 1 ? id - 1 : null });
    }
    const brBase = rows.find((r) => r.at === today - 40 * DAY + 10 * 3600_000)!;
    const branch = { id: ++id, at: today - 40 * DAY + 13 * 3600_000, base: brBase.id };
    rows.push(branch);
    const head = rows.filter((r) => r !== branch).at(-1)!;
    await seed("s206", head.id, rows);
    clock(today + 20 * 3600_000);
    await sweep();
    const left = new Set(await ids());

    // ожидание — прямо по словам правила, своими датами (неделя — с понедельника по getUTCDay)
    const age = (r: { at: number }) => Math.floor((today - Date.UTC(new Date(r.at).getUTCFullYear(), new Date(r.at).getUTCMonth(), new Date(r.at).getUTCDate())) / DAY);
    const monday = (r: { at: number }) => {
      const x = new Date(r.at);
      return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) - ((x.getUTCDay() + 6) % 7) * DAY;
    };
    const main = rows.filter((r) => r !== branch);
    const lastIn = (key: (r: { at: number }) => number, r: { at: number }) => !main.some((o) => key(o) === key(r) && o.at > r.at);
    const expected = new Set<number>();
    for (const r of main) {
      const a = age(r);
      if (a <= 1) expected.add(r.id);
      else if (a < 30 && lastIn(age, r)) expected.add(r.id);
      else if (a < 365 && lastIn(monday, r)) expected.add(r.id);
    }
    expected.add(head.id);
    expected.add(branch.id);
    expected.add(brBase.id);
    expect([...left].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
    expect(main.filter((r) => age(r) === 0).every((r) => left.has(r.id))).toBe(true);
    expect(main.filter((r) => age(r) >= 365).some((r) => left.has(r.id))).toBe(false);
    expect(left.size).toBeGreaterThan(80);
    expect(left.size).toBeLessThan(100);
  });

  it("207 · правило убирает точку 2: из хранилища уходит только c4 одним blocks.drop; второй прогон ничего не удаляет; на пустом реестре чужие блоки хранилища целы", async () => {
    await inStore("207a1", "207b7", "207c4");
    clock(T0 - 40 * DAY);
    await put("@laptop", "s207", file(["207a1"], 1));
    clock(T0 - 10 * DAY - 4 * 3600_000);
    await put("@laptop", "s207", file(["207a1", "207c4"], 2));
    clock(T0 - 10 * DAY - 2 * 3600_000);
    await put("@laptop", "s207", file(["207a1", "207b7"], 3));
    clock(T0);
    expect(await sweep()).toEqual({ points: 1, blocks: 1, bytes: 10 });
    expect(await count("SELECT COUNT(*) AS n FROM points WHERE id = 2")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM blocks WHERE hash = ?", H("207c4"))).toBe(0);
    expect([await STORE.has(H("207a1")), await STORE.has(H("207b7")), await STORE.has(H("207c4"))]).toEqual([true, true, false]);
    expect((await STORE.got()).filter((f) => f.type === "blocks.drop").map((f) => f.hashes)).toEqual([[H("207c4")]]);
    expect(await sweep()).toEqual({ points: 0, blocks: 0, bytes: 0 });
    await E.DB.batch(["sessions", "points", "blocks", "refs"].map((x) => E.DB.prepare(`DELETE FROM ${x}`)));
    const foreign = Array.from({ length: 500 }, (_, i) => H(`207ff${i.toString(16).padStart(4, "0")}`));
    for (const h of foreign) await STORE.put(h, 1);
    expect(await sweep()).toEqual({ points: 0, blocks: 0, bytes: 0 });
    expect((await Promise.all(foreign.map((h) => STORE.has(h)))).every(Boolean)).toBe(true);
  });

  it("сроки в списке: ветка — конец и точка линии, от которой она ушла, — год от конца ветки; средняя точка ветки — по дню", async () => {
    await seed("sk", 6, [
      { id: 1, at: D(2026, 1, 5, 10), base: null },
      { id: 2, at: D(2026, 1, 5, 11), base: 1 },
      { id: 3, at: D(2026, 1, 5, 12), base: 2 }, // ветка: 3 → 4
      { id: 4, at: D(2026, 1, 5, 13), base: 3 },
      { id: 5, at: D(2026, 1, 5, 14), base: 2 }, // линия идёт от 2
      { id: 6, at: D(2026, 6, 1, 9), base: 5 },
    ]);
    const u = await untilOf("sk");
    expect([u.get(4), u.get(2), u.get(3)]).toEqual([D(2026, 1, 5, 13) + YEAR, D(2026, 1, 5, 13) + YEAR, D(2026, 1, 7)]);
    // ветка дни линии не занимает: у линии последняя в дне и неделе остаётся её точка, хотя ветка позже
    await seed("sl", 15, [
      { id: 11, at: D(2026, 3, 4, 10), base: null },
      { id: 12, at: D(2026, 3, 4, 11), base: 11 },
      { id: 13, at: D(2026, 3, 4, 12), base: 12 },
      { id: 14, at: D(2026, 3, 4, 20), base: 11 },
      { id: 15, at: D(2026, 6, 1, 9), base: 13 },
    ]);
    expect((await untilOf("sl")).get(13)).toBe(D(2026, 3, 4) + YEAR);
  });

  it("стёртая точка: дети переходят к её основе — линия остаётся связной", async () => {
    // две стёртые подряд: ребёнок идёт к основе через обе
    await seed("sc", 4, [
      { id: 1, at: T0 - 40 * DAY, base: null },
      { id: 2, at: T0 - 40 * DAY + 1000, base: 1 },
      { id: 3, at: T0 - 40 * DAY + 2000, base: 2 },
      { id: 4, at: T0 - 1000, base: 3 },
    ]);
    await sweep();
    const r = await lineList("sc");
    expect(r.points.map((p) => [p.id, p.base])).toEqual([[4, 3], [3, null]]);
  });

  it("2071 · сессия без новых точек год уходит целиком: из обзора и её блоки из хранилища; голова тоже, не раньше", async () => {
    await inStore("2071a", "2071b");
    await put("@laptop", "s2071", file(["2071a"]));
    clock(T0 + YEAR - 1);
    await put("@laptop", "s2071n", file(["2071b"]));
    await sweep();
    expect(await sids()).toEqual(["s2071", "s2071n"]);
    clock(T0 + YEAR);
    await sweep();
    expect(await sids()).toEqual(["s2071n"]);
    expect([await STORE.has(H("2071a")), await STORE.has(H("2071b"))]).toEqual([false, true]);
  });

  it("2072 · уборка — расписанием Worker'а: срабатывание убирает и пишет время уборки; журнал без ключей", async () => {
    const lines = journal();
    clock(T0 + DAY);
    await worker.scheduled();
    expect(lines.at(-1)).toMatchObject({ part: "points", kind: "note", ev: "sweep", points: 0, blocks: 0, bytes: 0 });
    expect(((await list())[0].result as { sweep: { at: number } }).sweep.at).toBe(T0 + DAY);
  });
});

describe("удалить сессию", () => {
  it("208 · points.delete сессии: 57 точек и 212 блоков из хранилища в том же запросе, 88 общих с копией на месте; ledger.add session.deleted", async () => {
    const hashes = Array.from({ length: 300 }, (_, i) => `208${i.toString(16).padStart(4, "0")}`);
    await inStore(...hashes);
    await put("@laptop", "9f03", file(hashes), { callsign: "old-bot@laptop" });
    for (let i = 2; i <= 57; i++) await put("@laptop", "9f03", file(hashes.slice(0, 100 + i), i), { callsign: "old-bot@laptop" });
    const copy = await put("@pc", "7e19", file(hashes.slice(0, 88)), { why: "raise", base: 1, callsign: "old-bot-2@pc" });
    expect(copy[0]).toMatchObject({ ok: true });
    expect(copy[1]).toMatchObject({ type: "ledger.add", ev: "session.copied" });
    const out = await send({ type: "points.delete", v: 1, id: "d-1", to: ".points", from: "panel", sid: "9f03" });
    expect(out[0]).toEqual({ type: "reply", id: "d-1", ok: true, result: { points: 57, blocks: 212, bytes: 2120 }, to: "panel" });
    expect(out.slice(1)).toEqual([{ type: "ledger.add", v: 1, to: ".ledger", ev: "session.deleted", text: "old-bot удалена из архива · 57 точек", machine: "laptop", callsign: "old-bot@laptop", by: "panel" }]);
    const present = await Promise.all(hashes.map((h) => STORE.has(H(h))));
    expect(present.filter(Boolean)).toHaveLength(88);
    expect(present.slice(0, 88).every(Boolean)).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM points WHERE sid = '9f03'")).toBe(0);
    expect(await sids()).toEqual(["7e19"]);
  });

  it.each([
    ["машина не хозяин — not_owner", { from: "@mac", sid: "s304" }, [{ type: "reply", id: "d", ok: false, error: "not_owner", owner: "laptop", to: "@mac" }], 1],
    ["нет sid — bad_frame", { from: "@laptop" }, [expect.objectContaining({ ok: false, error: "bad_frame" })], 1],
    ["сессии нет — нули без события", { from: "panel", sid: "zz" }, [{ type: "reply", id: "d", ok: true, result: { points: 0, blocks: 0, bytes: 0 }, to: "panel" }], 1],
    ["хозяин удаляет; поле by идёт в журнал", { from: "@laptop", sid: "s304", by: "phone~a@b" }, [expect.objectContaining({ ok: true }), expect.objectContaining({ ev: "session.deleted", by: "phone~a@b" })], 0],
  ])("2070 2069 · points.delete: %s", async (_n, f, want, left) => {
    await inStore("304a1");
    await put("@laptop", "s304", file(["304a1"]));
    expect(await send({ type: "points.delete", v: 1, id: "d", to: ".points", ...f } as Frame)).toEqual(want);
    expect((await lineList("s304")).points).toHaveLength(left);
  });
});

describe("вход Worker'а", () => {
  it.each([
    ["машина не шлёт — шлёт пульт", "panel", {}],
    ["пустой sid", "@laptop", { sid: "" }],
    ["чужой повод", "@laptop", { why: "zzz" }],
    ["нет файлов", "@laptop", {}, []],
    ["отпечаток не hex", "@laptop", {}, [{ p: "x", size: 1, b: ["../etc"] }]],
    ["нет размера", "@laptop", {}, [{ p: "x", b: ["2064a"] }]],
    ["base не целое", "@laptop", { base: 1.5 }],
    ["подъём без base", "@laptop", { why: "raise", expect: "laptop" }],
    ["подъём из точки другой сессии", "@laptop", { why: "raise", base: "other", expect: "laptop" }],
  ] as Array<[string, string, Record<string, unknown>, unknown?]>)("2064 · points.put не по контракту — bad_frame, точек не прибавилось: %s", async (_n, from, extra, files) => {
    await inStore("2064a", "2064b");
    await put("@laptop", "s2064", file(["2064a"]));
    await put("@laptop", "s2064o", file(["2064b"]));
    const other = (await lineList("s2064o")).points[0];
    const x = extra.base === "other" ? { ...extra, base: other.id } : extra;
    expect(await put(from, "s2064", files ?? file(["2064a"], 7), x)).toMatchObject([{ ok: false, error: "bad_frame" }]);
    expect((await lineList("s2064")).points).toHaveLength(1);
  });

  it.each([[[]]])("2067 · points.get с ids %j — bad_frame", async (x) => {
    expect(await send({ type: "points.get", v: 2, id: "g", to: ".points", from: "panel", ids: x })).toMatchObject([{ ok: false, error: "bad_frame" }]);
  });

  it("2058 · чужое имя — unknown_request, другая версия — contract_mismatch, без id — только строка, reply — note", async () => {
    const lines = journal();
    expect(await send({ type: "points.drop", id: "d", to: ".points", from: "panel" })).toEqual([{ type: "reply", id: "d", ok: false, error: "unknown_request", to: "panel" }]);
    expect(await send({ type: "points.list", id: "d", v: 1, to: ".points", from: "panel" })).toMatchObject([{ ok: false, error: "contract_mismatch" }]);
    const p1 = (await send({ type: "points.put", id: "p", v: 2, to: ".points", from: "@laptop", sid: "s2058", why: "save", files: [] }))[0];
    expect(p1).toMatchObject({ ok: false, error: "contract_mismatch" });
    expect(p1).not.toHaveProperty("links");
    expect((await send({ type: "points.get", id: "g", v: 1, to: ".points", from: "@laptop", ids: [1] }))[0]).toMatchObject({ ok: false, error: "contract_mismatch" });
    expect(await count("SELECT COUNT(*) AS n FROM points WHERE sid = ?", "s2058")).toBe(0);
    expect(await send({ type: "points.list", v: 2, to: ".points", from: "panel" })).toEqual([]);
    expect(await send({ type: "reply", id: "x", ok: true, to: ".points", from: "panel" })).toEqual([]);
    expect(lines.map((l) => [l.part, l.kind, l.word ?? l.ev])).toEqual([
      ["points", "refuse", "unknown_request"],
      ["points", "refuse", "contract_mismatch"],
      ["points", "refuse", "contract_mismatch"],
      ["points", "refuse", "contract_mismatch"],
      ["points", "refuse", "bad_frame"],
      ["points", "note", "reply"],
    ]);
  });

  it("по привязке: ответом — только reply; строка журнала — привязкой LEDGER с from .points", async () => {
    await inStore("305a1");
    await LEDGER.clear();
    const sent = await worker.frame({ type: "points.put", v: 3, id: "p-1", to: ".points", from: "@laptop", sid: "s305", why: "rule", files: file(["305a1"]) });
    const head = (await sessionRow("s305")) as { head: number };
    sent.push(...(await worker.frame({ type: "points.put", v: 3, id: "p-2", to: ".points", from: "@pc", sid: "s305", why: "raise", base: head.head, expect: "laptop", files: file(["305a1"]) })));
    expect(sent.map((x) => [x.type, x.to])).toEqual([["reply", "@laptop"], ["reply", "@pc"]]);
    expect((await LEDGER.got()).map((x) => [x.type, x.from, x.ev])).toEqual([["ledger.add", ".points", "session.moved"]]);
  });

  it("прямой POST: пропуск говорит, кто пришёл; плохой пропуск — bad_key", async () => {
    const post = async (body: unknown) => (await worker.fetch(new Request("https://points.test/", { method: "POST", body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;
    expect(await post({ type: "points.list", v: 2, id: "a", key: "client.pult.k1.bad" })).toMatchObject({ ok: false, error: "bad_key" });
    expect(await post({ type: "points.list", v: 2, id: "b", key: "client.pult.k1.s" })).toMatchObject({ ok: true, result: { sessions: [] } });
    await inStore("306a");
    // машина кладёт точку своим пропуском, поле from кадра не считается
    expect(await post({ type: "points.put", v: 3, id: "c", key: "host.win.k2.s", from: "@mac", sid: "s306", why: "rule", files: file(["306a"]) })).toMatchObject({ ok: true, result: { id: 1 } });
    expect(await sessionRow("s306")).toEqual({ owner: "win", head: 1 });
  });
});
