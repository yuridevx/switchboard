// Леса границы «точка сессии», сторона Worker'а: только вход Worker'а — frame по привязке, POST с пропуском, расписание.
// Исход: кадр ответа, строки базы D1 и бакет R2 (их формат — контракт), строка журнала флота. Номер — эталон-источник; без номера — чьё: код.
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import { presign } from "@switchboard/release";

type Db = { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
const E = env as unknown as Db;
const LEDGER = (env as unknown as { LEDGER: { got(): Promise<Frame[]>; clear(): Promise<void> } }).LEDGER;
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

const list = (sid?: string) => send({ type: "points.list", v: 1, id: "l", to: ".points", from: "panel", ...(sid ? { sid } : {}) });
const put = (from: string, sid: string, files: unknown, extra: Record<string, unknown> = {}) =>
  send({ type: "points.put", v: 2, id: "p", to: ".points", from, sid, why: "rule", files, callsign: `site@${from.slice(1)}`, ...extra });
const file = (b: string[], size = 100, p = "s.jsonl") => [{ p, size, b }];

/** Ссылка на блок: ключ стенда, бакет точек, час. */
const linkOf = (method: "GET" | "PUT", h: string) =>
  presign({ accessKeyId: "kid0", secretAccessKey: "ksec0" }, { method, host: "acc0.r2.cloudflarestorage.com", path: `/switchboard-points/f/${h}`, now: new Date() });

async function inR2(...hashes: string[]) {
  for (const h of hashes) await (env as unknown as { BUCKET: R2Bucket }).BUCKET.put(`f/${h}`, "x".repeat(10));
}
const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;

const sessionRow = async (sid: string) => (await E.DB.prepare("SELECT owner, head FROM sessions WHERE sid = ?").bind(sid).first()) ?? undefined;
const count = async (q: string, ...args: Array<string | number>) => (await E.DB.prepare(q).bind(...args).first<{ n: number }>())!.n;

/** Запросы службы в сеть: ссылки подписываются на месте, в сеть служба не ходит. */
function net() {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return new Response(null, { status: 500 });
  });
  return calls;
}

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

/** Точки в базе напрямую: форма строк — контракт хранилища. */
async function seed(sid: string, head: number, rows: Array<{ id: number; at: number; base: number | null }>) {
  await E.DB.batch([
    ...rows.map((r) => E.DB.prepare("INSERT INTO points (id, sid, machine, at, why, base, files) VALUES (?, ?, 'laptop', ?, 'rule', ?, '[]')").bind(r.id, sid, r.at, r.base)),
    E.DB.prepare("INSERT INTO sessions (sid, owner, head) VALUES (?, 'laptop', ?)").bind(sid, head),
  ]);
}
type Listed = { owner: string | null; head: number | null; points: Array<{ id: number; base: number; line: boolean; until: number | null }> };
const lineList = async (sid: string) => (await list(sid))[0].result as Listed;
const untilOf = async (sid: string) => new Map((await lineList(sid)).points.map((p) => [p.id, p.until]));
const ids = async () => (await E.DB.prepare("SELECT id FROM points ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);

describe("снять точку", () => {
  it("200 · первая точка неизвестной сессии от @laptop: ok { id: 1 }, хозяин laptop, голова 1", async () => {
    await inR2("200a1", "200b7");
    expect(await put("@laptop", "42bc", file(["200a1", "200b7"]))).toEqual([{ type: "reply", id: "p", ok: true, result: { id: 1 }, to: "@laptop" }]);
    expect(await sessionRow("42bc")).toEqual({ owner: "laptop", head: 1 });
  });

  it("201 · хозяин pc; точка от @laptop с why rule — not_owner { owner: pc }, в R2 не ходили, строк столько же, голова прежняя", async () => {
    await inR2("201a1");
    await line("@pc", "s201", 2, ["201a1"]);
    const api = net();
    expect(await put("@laptop", "s201", file(["201a1", "201ff"], 99))).toEqual([{ type: "reply", id: "p", ok: false, error: "not_owner", owner: "pc", to: "@laptop" }]);
    expect(api).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM points")).toBe(2);
    expect(await sessionRow("s201")).toEqual({ owner: "pc", head: 2 });
  });

  it("202 2097 · блока b7 нет: missing и ссылка PUT ровно на него, путь /<бакет>/f/<отпечаток>, ключ ссылок, час; машина положила b7 — ok; блоки в обзоре", async () => {
    await inR2("202a1");
    await put("@laptop", "s202", file(["202a1"]));
    const api = net();
    const first = await put("@laptop", "s202", file(["202a1", "202b7"]));
    expect(first[0]).toMatchObject({ ok: false, error: "missing", missing: ["202b7"], links: { "202b7": await linkOf("PUT", "202b7") } });
    const links = (first[0] as unknown as { links: Record<string, string> }).links;
    expect(Object.keys(links)).toEqual(["202b7"]);
    const u = new URL(links["202b7"]);
    expect([u.host, u.pathname, u.searchParams.get("X-Amz-Expires")]).toEqual(["acc0.r2.cloudflarestorage.com", "/switchboard-points/f/202b7", "3600"]);
    expect(u.searchParams.get("X-Amz-Credential")).toMatch(/^kid0\//);
    expect(first[0]).not.toHaveProperty("creds");
    expect(api).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM points")).toBe(1);
    await inR2("202b7");
    expect((await put("@laptop", "s202", file(["202a1", "202b7"])))[0]).toMatchObject({ ok: true, result: { id: 2 } });
    expect(((await list())[0].result as { r2: { blocks: number } }).r2.blocks).toBe(2);
  });

  it("203 · голова 7, точка хозяина с теми же файлами — ok { id: 7, same: true }, новой строки нет", async () => {
    await inR2("203a1");
    expect((await line("@laptop", "s203", 7, ["203a1"])).at(-1)).toBe(7);
    expect((await put("@laptop", "s203", file(["203a1"], 7)))[0]).toMatchObject({ ok: true, result: { id: 7, same: true } });
    expect(await count("SELECT COUNT(*) AS n FROM points")).toBe(7);
  });

  it("строка точки хранит поля машины: путь, спецификация, git, первые слова — points.get отдаёт их как есть", async () => {
    await inR2("301a1", "301b2");
    await put("@laptop", "s301", file(["301a1", "301b2"]), { dir: "~/Projects/site", spec: { model: "opus" }, last: [["привет", "Готово"]], git: { state: "clean" }, msgs: 3, bytes: 7 });
    const row = await E.DB.prepare("SELECT sid, machine, at, why, base, callsign, dir, msgs, bytes, git, files, spec, last FROM points").first();
    expect(row).toEqual({ sid: "s301", machine: "laptop", at: T0, why: "rule", base: null, callsign: "site@laptop", dir: "~/Projects/site", msgs: 3, bytes: 7, git: '{"state":"clean"}', files: JSON.stringify(file(["301a1", "301b2"])), spec: '{"model":"opus"}', last: '[["привет","Готово"]]' });
    expect(await count("SELECT COUNT(*) AS n FROM refs WHERE point = 1")).toBe(2);
    expect((await E.DB.prepare("SELECT hash, size FROM blocks ORDER BY hash").all()).results).toEqual([{ hash: "301a1", size: 10 }, { hash: "301b2", size: 10 }]);
  });
});

describe("подъём и хозяин", () => {
  it("204 · подъём на pc с expect laptop — ok { id: 5 }, хозяин pc, один ledger.add session.moved; mac следом — not_owner { owner: pc }", async () => {
    await inR2("204a1");
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
    await inR2("205a1", "205c4");
    await line("@pc", "s205", 9, ["205a1"]);
    expect((await put("@mac", "s205", file(["205a1"], 9), { why: "raise", base: 9, expect: "pc" }))[0]).toMatchObject({ ok: true, result: { id: 10 } });
    expect(await put("@pc", "s205", file(["205a1", "205c4"], 10), { why: "yield" })).toEqual([{ type: "reply", id: "p", ok: true, result: { id: 11 }, to: "@pc" }]);
    expect(await sessionRow("s205")).toEqual({ owner: "mac", head: 10 });
    const pts = (await lineList("s205")).points;
    expect(pts.find((p) => p.id === 11)).toMatchObject({ base: 9, line: false });
    expect(pts.find((p) => p.id === 10)).toMatchObject({ line: true });
  });

  it("откат на той же машине — голова от base, ledger.add session.rolled_back; ветка «до отката» в списке, срок год", async () => {
    await inR2("302a1");
    await line("@pc", "s302", 4, ["302a1"]);
    const out = await put("@pc", "s302", file(["302a1"], 2), { why: "raise", base: 2, expect: "pc" });
    expect(out[0]).toMatchObject({ ok: true, result: { id: 5 } });
    expect(out[1]).toMatchObject({ type: "ledger.add", ev: "session.rolled_back", machine: "pc", text: "site@pc откатана к точке 2" });
    const r = await lineList("s302");
    expect([r.owner, r.head]).toEqual(["pc", 5]);
    expect(r.points.map((p) => [p.id, p.line])).toEqual([[5, true], [4, false], [3, false], [2, true], [1, true]]);
    expect(r.points[0].until).toBeNull();
    expect(r.points[1].until).toBe(T0 + YEAR);
  });

  it("2061 · копия — новый sid с base из другой сессии: хозяин — машина копии, исходная цела, session.copied", async () => {
    await inR2("2061a");
    const [p1] = await line("@laptop", "s2061", 1, ["2061a"]);
    const out = await put("@pc", "s2061c", file(["2061a"], 5), { base: p1, callsign: "copy@pc" });
    expect(out[0]).toMatchObject({ ok: true, to: "@pc" });
    expect(out[1]).toEqual({ type: "ledger.add", v: 1, to: ".ledger", ev: "session.copied", text: `site → copy@pc · из точки ${p1}`, machine: "pc", callsign: "copy@pc" });
    const r = await lineList("s2061c");
    expect(r.owner).toBe("pc");
    expect(r.points).toEqual([expect.objectContaining({ id: r.head, base: p1 })]);
    expect(await lineList("s2061")).toMatchObject({ owner: "laptop", head: p1 });
  });

  it("2062 · основы нет — no_point с номером: у копии и у подъёма", async () => {
    await inR2("2062a");
    await line("@laptop", "s2062", 1, ["2062a"]);
    expect(await put("@pc", "s2062c", file(["2062a"]), { base: 99 })).toEqual([{ type: "reply", id: "p", ok: false, error: "no_point", ids: [99], to: "@pc" }]);
    expect(await put("@pc", "s2062", file(["2062a"]), { why: "raise", base: 99, expect: "laptop" })).toMatchObject([{ ok: false, error: "no_point", ids: [99] }]);
  });

  it("2065 · подъём хозяином от своей головы — точка без события", async () => {
    await inR2("2065a");
    const pts = await line("@laptop", "s2065", 2, ["2065a"]);
    const out = await put("@laptop", "s2065", file(["2065a"], 2), { why: "raise", base: pts[1], expect: "laptop" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ok: true });
    const r = await lineList("s2065");
    expect([r.owner, r.points.find((x) => x.id === r.head)?.base]).toEqual(["laptop", pts[1]]);
  });

  it("2066 · прежний хозяин вернулся без нового — same, пустой ветки нет", async () => {
    await inR2("2066a");
    const pts = await line("@laptop", "s2066", 2, ["2066a"]);
    await put("@pc", "s2066", file(["2066a"], 2), { why: "raise", base: pts[1], expect: "laptop" });
    const before = await lineList("s2066");
    expect(await put("@laptop", "s2066", file(["2066a"], 2), { why: "yield" })).toEqual([{ type: "reply", id: "p", ok: true, result: { id: pts[1], same: true }, to: "@laptop" }]);
    const after = await lineList("s2066");
    expect([after.owner, after.head, after.points.length]).toEqual([before.owner, before.head, before.points.length]);
  });
});

describe("вернуть: points.get и points.list", () => {
  it("2098 · points.get: машине — строки, хозяин и ссылки GET на блоки этих точек и только их; пульту — без ссылок; нет точки — no_point", async () => {
    await inR2("301a1", "301b2", "302c3");
    await put("@laptop", "s301", file(["301a1", "301b2"]), { dir: "~/Projects/site", spec: { model: "opus" }, last: [["привет", "Готово"]], git: { state: "clean" }, msgs: 3 });
    await put("@laptop", "s302", file(["302c3"]));
    const api = net();
    const [m] = await send({ type: "points.get", v: 2, id: "g", to: ".points", from: "@pc", ids: [1] });
    expect(m.result).toMatchObject({
      owner: "laptop",
      points: [{ id: 1, sid: "s301", machine: "laptop", why: "rule", base: null, dir: "~/Projects/site", spec: { model: "opus" }, last: [["привет", "Готово"]], git: { state: "clean" }, msgs: 3, files: file(["301a1", "301b2"]) }],
    });
    expect((m.result as { links: Record<string, string> }).links).toEqual({ "301a1": await linkOf("GET", "301a1"), "301b2": await linkOf("GET", "301b2") });
    expect(api).toHaveLength(0);
    const [p] = await send({ type: "points.get", v: 2, id: "g", to: ".points", from: "panel", ids: [1] });
    expect((p.result as Record<string, unknown>).links).toBeUndefined();
    expect(await send({ type: "points.get", v: 2, id: "g", to: ".points", from: "panel", ids: [1, 9] })).toEqual([{ type: "reply", id: "g", ok: false, error: "no_point", ids: [9], to: "panel" }]);
  });

  it("обзор флота: сессии, место в R2, итог уборки; поля без значения не приходят", async () => {
    await inR2("303a1", "303b7");
    await put("@laptop", "s303", file(["303a1", "303b7"]), { dir: "~/x" });
    await sweep();
    expect((await list())[0].result).toEqual({
      sessions: [{ sid: "s303", callsign: "site@laptop", dir: "~/x", owner: "laptop", head: { id: 1, at: T0 }, points: 1, branches: 0 }],
      r2: { bytes: 20, blocks: 2 },
      sweep: { at: T0, blocks: 0, bytes: 0 },
    });
    expect((await list("nope"))[0].result).toEqual({ owner: null, head: null, points: [] }); // 2068
    await E.DB.prepare("INSERT INTO points (id, sid, machine, at, why, base, files) VALUES (50, 'bare', 'laptop', ?, 'rule', NULL, '[]')").bind(T0 + 1).run();
    await E.DB.prepare("INSERT INTO sessions (sid, owner, head) VALUES ('bare', 'laptop', 50)").run();
    expect(((await list())[0].result as { sessions: unknown[] }).sessions[0]).toEqual({ sid: "bare", owner: "laptop", head: { id: 50, at: T0 + 1 }, points: 1, branches: 0 });
  });

  it("обзор считает ветки: конец без детей, кроме головы", async () => {
    await seed("sb", 3, [
      { id: 1, at: T0 - 3, base: null },
      { id: 2, at: T0 - 2, base: 1 },
      { id: 3, at: T0 - 1, base: 1 },
    ]);
    expect(((await list())[0].result as { sessions: Array<{ points: number; branches: number }> }).sessions[0]).toMatchObject({ points: 3, branches: 1 });
  });

  it("список сессии: точки от новых к старым, без файлов, спецификации и первых слов", async () => {
    await inR2("304c");
    await put("@laptop", "s304c", file(["304c"]), { spec: { model: "opus" }, last: [["a", "b"]], msgs: 1, bytes: 2, git: { state: "clean" }, dir: "~/d" });
    await put("@laptop", "s304c", file(["304c"], 2));
    const pts = (await lineList("s304c")).points as unknown as Array<Record<string, unknown>>;
    expect(pts.map((p) => p.id)).toEqual([2, 1]);
    expect(pts[1]).toEqual({ id: 1, machine: "laptop", at: T0, why: "rule", base: null, callsign: "site@laptop", dir: "~/d", msgs: 1, bytes: 2, git: { state: "clean" }, line: true, until: expect.any(Number) });
  });
});

describe("правило хранения: срок в списке и уборка расписанием", () => {
  it("206 · 400 дней по две точки, шесть сегодня, ветка 40 дней назад: уборка оставляет ровно то, что велит правило", async () => {
    const today = Date.UTC(2026, 9, 31);
    const rows: Array<{ id: number; at: number; base: number | null }> = [];
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

  it("207 · правило убирает точку 2: из R2 уходит только c4; второй прогон ничего не удаляет; на пустом реестре чужие блоки бакета целы", async () => {
    await inR2("207a1", "207b7", "207c4");
    clock(T0 - 40 * DAY);
    await put("@laptop", "s207", file(["207a1"], 1));
    clock(T0 - 10 * DAY - 4 * 3600_000);
    await put("@laptop", "s207", file(["207a1", "207c4"], 2));
    clock(T0 - 10 * DAY - 2 * 3600_000);
    await put("@laptop", "s207", file(["207a1", "207b7"], 3));
    clock(T0);
    expect(await sweep()).toEqual({ points: 1, blocks: 1, bytes: 10 });
    expect(await count("SELECT COUNT(*) AS n FROM points WHERE id = 2")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM blocks WHERE hash = '207c4'")).toBe(0);
    expect([await bucket().head("f/207a1"), await bucket().head("f/207b7"), await bucket().head("f/207c4")].map((o) => !!o)).toEqual([true, true, false]);
    expect(await sweep()).toEqual({ points: 0, blocks: 0, bytes: 0 });
    await E.DB.batch(["sessions", "points", "blocks", "refs"].map((x) => E.DB.prepare(`DELETE FROM ${x}`)));
    for (let i = 0; i < 500; i++) await bucket().put(`f/207ff${i.toString(16).padStart(4, "0")}`, "x");
    expect(await sweep()).toEqual({ points: 0, blocks: 0, bytes: 0 });
    expect((await bucket().list({ prefix: "f/207ff", limit: 1000 })).objects).toHaveLength(500);
  });

  it("сроки: голова — без срока; не последняя в дне — до послезавтра; последняя в дне — 30 дней; последняя в неделе — год", async () => {
    await seed("sk", 4, [
      { id: 1, at: D(2026, 10, 1, 10), base: null }, // четверг
      { id: 2, at: D(2026, 10, 1, 18), base: 1 },
      { id: 3, at: D(2026, 10, 2, 18), base: 2 }, // пятница — последняя в неделе
      { id: 4, at: D(2026, 10, 31, 9), base: 3 },
    ]);
    const u = await untilOf("sk");
    expect(u.get(4)).toBeNull();
    expect(u.get(1)).toBe(D(2026, 10, 3));
    expect(u.get(2)).toBe(D(2026, 10, 31));
    expect(u.get(3)).toBe(D(2026, 10, 2) + YEAR);
  });

  it("неделя — с понедельника: воскресенье и следующий понедельник в разных неделях", async () => {
    // 2026-11-01 — воскресенье, 2026-11-02 — понедельник; голова дальше, обе точки — последние в своём дне
    await seed("sw", 3, [
      { id: 1, at: D(2026, 11, 1, 23), base: null },
      { id: 2, at: D(2026, 11, 2, 1), base: 1 },
      { id: 3, at: D(2026, 11, 20, 1), base: 2 },
    ]);
    const u = await untilOf("sw");
    expect(u.get(1)).toBe(D(2026, 11, 1) + YEAR);
    expect(u.get(2)).toBe(D(2026, 11, 2) + YEAR);
  });

  it("ветка: конец и точка линии, от которой она ушла, — год от конца ветки; средняя точка ветки — по дню", async () => {
    await seed("sbr", 6, [
      { id: 1, at: D(2026, 1, 5, 10), base: null },
      { id: 2, at: D(2026, 1, 5, 11), base: 1 },
      { id: 3, at: D(2026, 1, 5, 12), base: 2 }, // ветка: 3 → 4
      { id: 4, at: D(2026, 1, 5, 13), base: 3 },
      { id: 5, at: D(2026, 1, 5, 14), base: 2 }, // линия идёт от 2
      { id: 6, at: D(2026, 6, 1, 9), base: 5 },
    ]);
    expect((await lineList("sbr")).points.filter((p) => p.line).map((p) => p.id).sort()).toEqual([1, 2, 5, 6]);
    const u = await untilOf("sbr");
    expect(u.get(4)).toBe(D(2026, 1, 5, 13) + YEAR);
    expect(u.get(2)).toBe(D(2026, 1, 5, 13) + YEAR);
    expect(u.get(3)).toBe(D(2026, 1, 7));
  });

  it("стёртая точка: дети переходят к её основе — линия остаётся связной", async () => {
    await seed("sc", 3, [
      { id: 1, at: T0 - 40 * DAY, base: null },
      { id: 2, at: T0 - 40 * DAY + 1000, base: 1 },
      { id: 3, at: T0 - 1000, base: 2 },
    ]);
    await sweep();
    const r = await lineList("sc");
    expect(r.points.map((p) => [p.id, p.base])).toEqual([[3, 2], [2, null]]);
  });

  it("2071 · сессия без новых точек год уходит целиком: из обзора и её блоки из R2; голова тоже, не раньше", async () => {
    await inR2("2071a", "2071b");
    await put("@laptop", "s2071", file(["2071a"]));
    clock(T0 + YEAR - 1);
    await put("@laptop", "s2071n", file(["2071b"]));
    await sweep();
    expect(((await list())[0].result as { sessions: Array<{ sid: string }> }).sessions.map((x) => x.sid).sort()).toEqual(["s2071", "s2071n"]);
    clock(T0 + YEAR);
    await sweep();
    expect(((await list())[0].result as { sessions: Array<{ sid: string }> }).sessions.map((x) => x.sid)).toEqual(["s2071n"]);
    expect([!!(await bucket().head("f/2071a")), !!(await bucket().head("f/2071b"))]).toEqual([false, true]);
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
  it("208 · points.delete сессии: 57 точек и 212 блоков из R2 в том же запросе, 88 общих с копией на месте; ledger.add session.deleted", async () => {
    const hashes = Array.from({ length: 300 }, (_, i) => `208${i.toString(16).padStart(4, "0")}`);
    await inR2(...hashes);
    await put("@laptop", "9f03", file(hashes), { callsign: "old-bot@laptop" });
    for (let i = 2; i <= 57; i++) await put("@laptop", "9f03", file(hashes.slice(0, 100 + i), i), { callsign: "old-bot@laptop" });
    const copy = await put("@pc", "7e19", file(hashes.slice(0, 88)), { why: "raise", base: 1, callsign: "old-bot-2@pc" });
    expect(copy[0]).toMatchObject({ ok: true });
    expect(copy[1]).toMatchObject({ type: "ledger.add", ev: "session.copied" });
    const out = await send({ type: "points.delete", v: 1, id: "d-1", to: ".points", from: "panel", sid: "9f03" });
    expect(out[0]).toEqual({ type: "reply", id: "d-1", ok: true, result: { points: 57, blocks: 212, bytes: 2120 }, to: "panel" });
    expect(out.slice(1)).toEqual([{ type: "ledger.add", v: 1, to: ".ledger", ev: "session.deleted", text: "old-bot удалена из R2 · 57 точек", machine: "laptop", callsign: "old-bot@laptop", by: "panel" }]);
    const present = await Promise.all(hashes.map((h) => bucket().head(`f/${h}`)));
    expect(present.filter(Boolean)).toHaveLength(88);
    expect(present.slice(0, 88).every(Boolean)).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM points WHERE sid = '9f03'")).toBe(0);
    expect(((await list())[0].result as { sessions: Array<{ sid: string }> }).sessions.map((x) => x.sid)).toEqual(["7e19"]);
  });

  it("2070 2069 · машина не хозяин — not_owner; нет sid — bad_frame; сессии нет — нули без события; поле by идёт в журнал", async () => {
    await inR2("304a1");
    await put("@laptop", "s304", file(["304a1"]));
    expect(await send({ type: "points.delete", v: 1, id: "d", to: ".points", from: "@mac", sid: "s304" })).toEqual([{ type: "reply", id: "d", ok: false, error: "not_owner", owner: "laptop", to: "@mac" }]);
    expect(await send({ type: "points.delete", v: 1, id: "d", to: ".points", from: "@laptop" })).toMatchObject([{ ok: false, error: "bad_frame" }]);
    expect((await lineList("s304")).points).toHaveLength(1);
    expect(await send({ type: "points.delete", v: 1, id: "d", to: ".points", from: "panel", sid: "zz" })).toEqual([{ type: "reply", id: "d", ok: true, result: { points: 0, blocks: 0, bytes: 0 }, to: "panel" }]);
    const out = await send({ type: "points.delete", v: 1, id: "d", to: ".points", from: "@laptop", sid: "s304", by: "phone~a@b" });
    expect(out[1]).toMatchObject({ ev: "session.deleted", by: "phone~a@b" });
  });
});

describe("вход Worker'а", () => {
  it("2064 2067 · вход не по контракту — bad_frame, точек не прибавилось", async () => {
    await inR2("2064a", "2064b");
    await put("@laptop", "s2064", file(["2064a"]));
    await put("@laptop", "s2064o", file(["2064b"]));
    const other = (await lineList("s2064o")).points[0];
    const bad: Array<[string, Record<string, unknown>, unknown?]> = [
      ["panel", {}],
      ["@laptop", { sid: "" }],
      ["@laptop", { why: "zzz" }],
      ["@laptop", {}, []],
      ["@laptop", {}, [{ p: "x", size: 1, b: ["../etc"] }]],
      ["@laptop", {}, [{ p: "x", b: ["2064a"] }]],
      ["@laptop", { base: 1.5 }],
      ["@laptop", { why: "raise", expect: "laptop" }],
      ["@laptop", { why: "raise", base: other.id, expect: "laptop" }],
    ];
    for (const [from, extra, files] of bad) expect(await put(from, "s2064", files ?? file(["2064a"], 7), extra), JSON.stringify(extra)).toMatchObject([{ ok: false, error: "bad_frame" }]);
    expect((await lineList("s2064")).points).toHaveLength(1);
    for (const ids of [undefined, [], ["a"], [1.5]]) expect(await send({ type: "points.get", v: 2, id: "g", to: ".points", from: "panel", ids })).toMatchObject([{ ok: false, error: "bad_frame" }]);
  });

  it("2058 · чужое имя — unknown_request, другая версия — contract_mismatch, без id — только строка, reply — note", async () => {
    const lines = journal();
    expect(await send({ type: "points.drop", id: "d", to: ".points", from: "panel" })).toEqual([{ type: "reply", id: "d", ok: false, error: "unknown_request", to: "panel" }]);
    expect(await send({ type: "points.list", id: "d", v: 2, to: ".points", from: "panel" })).toMatchObject([{ ok: false, error: "contract_mismatch" }]);
    const p1 = (await send({ type: "points.put", id: "p", v: 1, to: ".points", from: "@laptop", sid: "s2058", why: "save", files: [] }))[0];
    expect(p1).toMatchObject({ ok: false, error: "contract_mismatch" });
    expect(p1).not.toHaveProperty("links");
    expect((await send({ type: "points.get", id: "g", v: 1, to: ".points", from: "@laptop", ids: [1] }))[0]).toMatchObject({ ok: false, error: "contract_mismatch" });
    expect(await count("SELECT COUNT(*) AS n FROM points WHERE sid = ?", "s2058")).toBe(0);
    expect(await send({ type: "points.list", v: 1, to: ".points", from: "panel" })).toEqual([]);
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
    await inR2("305a1");
    await LEDGER.clear();
    const sent = await worker.frame({ type: "points.put", v: 2, id: "p-1", to: ".points", from: "@laptop", sid: "s305", why: "rule", files: file(["305a1"]) });
    const head = (await sessionRow("s305")) as { head: number };
    sent.push(...(await worker.frame({ type: "points.put", v: 2, id: "p-2", to: ".points", from: "@pc", sid: "s305", why: "raise", base: head.head, expect: "laptop", files: file(["305a1"]) })));
    expect(sent.map((x) => [x.type, x.to])).toEqual([["reply", "@laptop"], ["reply", "@pc"]]);
    expect((await LEDGER.got()).map((x) => [x.type, x.from, x.ev])).toEqual([["ledger.add", ".points", "session.moved"]]);
  });

  it("прямой POST: пропуск говорит, кто пришёл; плохой пропуск — bad_key", async () => {
    const post = async (body: unknown) => (await worker.fetch(new Request("https://points.test/", { method: "POST", body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;
    expect(await post({ type: "points.list", v: 1, id: "a", key: "client.pult.k1.bad" })).toMatchObject({ ok: false, error: "bad_key" });
    expect(await post({ type: "points.list", v: 1, id: "b", key: "client.pult.k1.s" })).toMatchObject({ ok: true, result: { sessions: [] } });
    await inR2("306a");
    // машина кладёт точку своим пропуском, поле from кадра не считается
    expect(await post({ type: "points.put", v: 2, id: "c", key: "host.win.k2.s", from: "@mac", sid: "s306", why: "rule", files: file(["306a"]) })).toMatchObject({ ok: true, result: { id: 1 } });
    expect(await sessionRow("s306")).toEqual({ owner: "win", head: 1 });
  });
});
