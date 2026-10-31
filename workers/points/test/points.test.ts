import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import type { Registry } from "../src/registry.ts";

const relay = (exports as unknown as { default: { hello(): Promise<unknown>; frame(f: Frame): Promise<void> } }).default;
type Stub = DurableObjectStub & { frame(f: Frame): Promise<Frame[]> };
const sweep = (s: Stub) => runInDurableObject(s, (o) => (o as unknown as Registry).sweep());
let n = 0;
const fresh = () => env.REGISTRY.get(env.REGISTRY.idFromName(`t-${++n}-${Math.random()}`)) as unknown as Stub;

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 31, 20, 0);
const clock = (t: number) => vi.setSystemTime(t);

/** Поддельный API Cloudflare: выдаёт временный ключ и записывает тела запросов. */
function fakeCf(status = 200) {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, auth: req.headers.get("authorization"), body: await req.json() });
    if (status !== 200) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status });
    return Response.json({ success: true, result: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" } });
  });
  return calls;
}

/** Блоки, уже лежащие в R2. */
async function inR2(...hashes: string[]) {
  for (const h of hashes) await env.BUCKET.put(`f/${h}`, "x".repeat(10));
}

const file = (b: string[], size = 100, p = "s.jsonl") => [{ p, size, b }];

const put = (s: Stub, from: string, sid: string, files: unknown, extra: Record<string, unknown> = {}) =>
  s.frame({ type: "points.put", id: "p", to: "points", from, sid, why: "rule", files, callsign: `site@${from.slice(1)}`, ...extra });

const sessionRow = (s: Stub, sid: string) =>
  runInDurableObject(s, (_o, st) => st.storage.sql.exec("SELECT owner, head FROM sessions WHERE sid = ?", sid).toArray()[0]);
const count = (s: Stub, q: string, ...args: unknown[]) =>
  runInDurableObject(s, (_o, st) => (st.storage.sql.exec(q, ...args).one() as { n: number }).n);

/** Сессия из k точек хозяина: файлы у каждой свои (size — номер). */
async function line(s: Stub, from: string, sid: string, k: number, b: string[]) {
  const ids: number[] = [];
  for (let i = 1; i <= k; i++) {
    const [r] = await put(s, from, sid, file(b, i));
    ids.push((r.result as { id: number }).id);
  }
  return ids;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(T0);
  await env.RELAY_LOG.take();
  await env.RELAY_LOG.answer();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("эталоны points", () => {
  it("200 · первая точка неизвестной сессии от @laptop: ok { id: 1 }, хозяин laptop, голова 1", async () => {
    const s = fresh();
    await inR2("200a1", "200b7");
    const out = await put(s, "@laptop", "42bc", file(["200a1", "200b7"]));
    expect(out).toEqual([{ type: "reply", id: "p", ok: true, result: { id: 1 }, to: "@laptop" }]);
    expect(await sessionRow(s, "42bc")).toEqual({ owner: "laptop", head: 1 });
  });

  it("201 · хозяин pc; точка от @laptop с why rule — not_owner { owner: pc }, строк столько же, голова прежняя", async () => {
    const s = fresh();
    await inR2("201a1");
    await line(s, "@pc", "s201", 2, ["201a1"]);
    const out = await put(s, "@laptop", "s201", file(["201a1"], 99));
    expect(out).toEqual([{ type: "reply", id: "p", ok: false, error: "not_owner", owner: "pc", to: "@laptop" }]);
    expect(await count(s, "SELECT COUNT(*) AS n FROM points")).toBe(2);
    expect(await sessionRow(s, "s201")).toEqual({ owner: "pc", head: 2 });
  });

  it("202 · блока b7 нет: missing и ключ на запись f/ на час, строки нет; после того как машина положила b7 — ok", async () => {
    const s = fresh();
    await inR2("202a1");
    await put(s, "@laptop", "s202", file(["202a1"]));
    const api = fakeCf();
    const first = await put(s, "@laptop", "s202", file(["202a1", "202b7"]));
    expect(first[0]).toMatchObject({ ok: false, error: "missing", missing: ["202b7"], creds: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", bucket: "switchboard-points", endpoint: "https://acc0.r2.cloudflarestorage.com" } });
    expect(api).toHaveLength(1);
    expect(api[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc0/r2/temp-access-credentials");
    expect(api[0].auth).toBe("Bearer test-token");
    expect(api[0].body).toEqual({ bucket: "switchboard-points", parentAccessKeyId: "parent0", permission: "object-read-write", prefixes: ["f/"], ttlSeconds: 3600 });
    expect(await count(s, "SELECT COUNT(*) AS n FROM points")).toBe(1);
    await inR2("202b7");
    const second = await put(s, "@laptop", "s202", file(["202a1", "202b7"]));
    expect(second[0]).toMatchObject({ ok: true, result: { id: 2 } });
    expect(await count(s, "SELECT COUNT(*) AS n FROM blocks WHERE hash = ?", "202b7")).toBe(1);
  });

  it("203 · голова 7, точка хозяина с теми же файлами — ok { id: 7, same: true }, новой строки нет", async () => {
    const s = fresh();
    await inR2("203a1");
    const ids = await line(s, "@laptop", "s203", 7, ["203a1"]);
    expect(ids.at(-1)).toBe(7);
    const out = await put(s, "@laptop", "s203", file(["203a1"], 7));
    expect(out[0]).toMatchObject({ ok: true, result: { id: 7, same: true } });
    expect(await count(s, "SELECT COUNT(*) AS n FROM points")).toBe(7);
  });

  it("204 · подъём на pc с expect laptop — ok { id: 5 }, хозяин pc, один ledger.add session.moved; mac следом — not_owner { owner: pc }", async () => {
    const s = fresh();
    await inR2("204a1");
    await line(s, "@laptop", "s204", 4, ["204a1"]);
    const pc = await put(s, "@pc", "s204", file(["204a1"], 4), { why: "raise", base: 4, expect: "laptop", by: "panel" });
    expect(pc[0]).toMatchObject({ ok: true, result: { id: 5 }, to: "@pc" });
    expect(pc.filter((x) => x.type === "ledger.add")).toEqual([
      { type: "ledger.add", v: 1, to: "ledger", ev: "session.moved", text: "site: laptop → pc · из точки 4", machine: "pc", callsign: "site@pc", by: "panel" },
    ]);
    expect(await sessionRow(s, "s204")).toEqual({ owner: "pc", head: 5 });
    const mac = await put(s, "@mac", "s204", file(["204a1"], 4), { why: "raise", base: 4, expect: "laptop" });
    expect(mac).toEqual([{ type: "reply", id: "p", ok: false, error: "not_owner", owner: "pc", to: "@mac" }]);
  });

  it("205 · вернувшийся pc отдаёт сессию: yield — точка 11 от его 9, хозяин mac, голова 10; в списке у 11 line: false", async () => {
    const s = fresh();
    await inR2("205a1", "205c4");
    await line(s, "@pc", "s205", 9, ["205a1"]);
    const raise = await put(s, "@mac", "s205", file(["205a1"], 9), { why: "raise", base: 9, expect: "pc" });
    expect(raise[0]).toMatchObject({ ok: true, result: { id: 10 } });
    const y = await put(s, "@pc", "s205", file(["205a1", "205c4"], 10), { why: "yield" });
    expect(y).toEqual([{ type: "reply", id: "p", ok: true, result: { id: 11 }, to: "@pc" }]);
    expect(await sessionRow(s, "s205")).toEqual({ owner: "mac", head: 10 });
    const [l] = await s.frame({ type: "points.list", id: "l", to: "points", from: "panel", sid: "s205" });
    const pts = (l.result as { points: Array<{ id: number; base: number; line: boolean }> }).points;
    expect(pts.find((p) => p.id === 11)).toMatchObject({ base: 9, line: false });
    expect(pts.find((p) => p.id === 10)).toMatchObject({ line: true });
  });

  it("206 · 400 дней по две точки, шесть сегодня, ветка 40 дней назад: уборка оставляет ровно то, что велит правило", async () => {
    const s = fresh();
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
    await runInDurableObject(s, (_o, st) => {
      for (const r of rows)
        st.storage.sql.exec("INSERT INTO points (id, sid, machine, at, why, base, files) VALUES (?, 's206', 'laptop', ?, 'rule', ?, '[]')", r.id, r.at, r.base);
      st.storage.sql.exec("INSERT INTO sessions (sid, owner, head) VALUES ('s206', 'laptop', ?)", head.id);
    });
    clock(today + 20 * 3600_000);
    await sweep(s);
    const left = new Set(await runInDurableObject(s, (_o, st) => st.storage.sql.exec<{ id: number }>("SELECT id FROM points").toArray().map((r) => r.id)));

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
    // контрольные точки: сегодня все шесть; старше года — ничего
    expect(main.filter((r) => age(r) === 0).every((r) => left.has(r.id))).toBe(true);
    expect(main.filter((r) => age(r) >= 365).some((r) => left.has(r.id))).toBe(false);
    expect(left.size).toBeGreaterThan(80);
    expect(left.size).toBeLessThan(100);
  });

  it("207 · правило убирает точку 2: из R2 уходит только c4; второй прогон на пустом реестре не удаляет ничего", async () => {
    const s = fresh();
    // объект создан «сегодня»: его суточный будильник — завтра, уборку в тесте зовём сами
    await s.frame({ type: "points.list", id: "l", to: "points", from: "panel" });
    await inR2("207a1", "207b7", "207c4");
    clock(T0 - 40 * DAY);
    await put(s, "@laptop", "s207", file(["207a1"], 1));
    clock(T0 - 10 * DAY - 4 * 3600_000);
    await put(s, "@laptop", "s207", file(["207a1", "207c4"], 2));
    clock(T0 - 10 * DAY - 2 * 3600_000);
    await put(s, "@laptop", "s207", file(["207a1", "207b7"], 3));
    clock(T0);
    const r = await sweep(s);
    expect(r).toEqual({ points: 1, blocks: 1, bytes: 10 });
    expect(await count(s, "SELECT COUNT(*) AS n FROM points WHERE id = 2")).toBe(0);
    expect(await count(s, "SELECT COUNT(*) AS n FROM blocks WHERE hash = '207c4'")).toBe(0);
    expect([await env.BUCKET.head("f/207a1"), await env.BUCKET.head("f/207b7"), await env.BUCKET.head("f/207c4")].map((o) => !!o)).toEqual([true, true, false]);

    const empty = fresh();
    for (let i = 0; i < 500; i++) await env.BUCKET.put(`f/207ff${i.toString(16).padStart(4, "0")}`, "x");
    expect(await sweep(empty)).toEqual({ points: 0, blocks: 0, bytes: 0 });
    expect((await env.BUCKET.list({ prefix: "f/207ff", limit: 1000 })).objects).toHaveLength(500);
  });

  it("208 · points.delete сессии: 57 точек и 212 блоков из R2 в том же запросе, 88 общих с копией на месте; ledger.add session.deleted", async () => {
    const s = fresh();
    const hashes = Array.from({ length: 300 }, (_, i) => `208${i.toString(16).padStart(4, "0")}`);
    await inR2(...hashes);
    await put(s, "@laptop", "9f03", file(hashes), { callsign: "old-bot@laptop" });
    for (let i = 2; i <= 57; i++) await put(s, "@laptop", "9f03", file(hashes.slice(0, 100 + i), i), { callsign: "old-bot@laptop" });
    const copy = await put(s, "@pc", "7e19", file(hashes.slice(0, 88)), { why: "raise", base: 1, callsign: "old-bot-2@pc" });
    expect(copy[0]).toMatchObject({ ok: true });
    expect(copy[1]).toMatchObject({ type: "ledger.add", ev: "session.copied" });
    const out = await s.frame({ type: "points.delete", id: "d-1", to: "points", from: "panel", sid: "9f03" });
    expect(out[0]).toEqual({ type: "reply", id: "d-1", ok: true, result: { points: 57, blocks: 212, bytes: 2120 }, to: "panel" });
    expect(out.slice(1)).toEqual([
      { type: "ledger.add", v: 1, to: "ledger", ev: "session.deleted", text: "old-bot удалена из R2 · 57 точек", machine: "laptop", callsign: "old-bot@laptop", by: "panel" },
    ]);
    const present = await Promise.all(hashes.map((h) => env.BUCKET.head(`f/${h}`)));
    expect(present.filter(Boolean)).toHaveLength(88);
    expect(present.slice(0, 88).every(Boolean)).toBe(true);
    expect(await count(s, "SELECT COUNT(*) AS n FROM points WHERE sid = '9f03'")).toBe(0);
    const [l] = await s.frame({ type: "points.list", id: "l", to: "points", from: "panel" });
    expect((l.result as { sessions: Array<{ sid: string }> }).sessions.map((x) => x.sid)).toEqual(["7e19"]);
  });

  it("209 · hello() — ровно пять запросов points", async () => {
    expect(await relay.hello()).toEqual({ contract: { "points.put": 1, "points.get": 1, "points.list": 1, "points.delete": 1, "points.creds": 1 } });
  });

  it("257 · points.creds от машины — ключ на чтение бакета выпусков без префиксов; от клиента — bad_frame, API не звали", async () => {
    const s = fresh();
    const api = fakeCf();
    const [mine] = await s.frame({ type: "points.creds", id: "c-2", to: "points", from: "@laptop" });
    expect(api.map((c) => c.body)).toEqual([{ bucket: "switchboard-releases", parentAccessKeyId: "parent0", permission: "object-read-only", ttlSeconds: 3600 }]);
    expect(mine).toMatchObject({ ok: true, to: "@laptop", result: { creds: { bucket: "switchboard-releases", accessKeyId: "AK", exp: T0 + 3600_000 } } });
    const [theirs] = await s.frame({ type: "points.creds", id: "c-3", to: "points", from: "panel" });
    expect(theirs).toEqual({ type: "reply", id: "c-3", ok: false, error: "bad_frame", to: "panel" });
    expect(api).toHaveLength(1);
  });
});

describe("points: get, list, откат, отказы, стык с relay", () => {
  it("points.get: машине — строки, хозяин и ключ на чтение f/; пульту — без ключа; нет точки — no_point", async () => {
    const s = fresh();
    await inR2("301a1");
    await put(s, "@laptop", "s301", file(["301a1"]), { dir: "~/Projects/site", spec: { model: "opus" }, last: [["привет", "Готово"]], git: { state: "clean" }, msgs: 3 });
    const api = fakeCf();
    const [m] = await s.frame({ type: "points.get", id: "g", to: "points", from: "@pc", ids: [1] });
    expect(m.result).toMatchObject({
      owner: "laptop",
      points: [{ id: 1, sid: "s301", machine: "laptop", why: "rule", base: null, dir: "~/Projects/site", spec: { model: "opus" }, last: [["привет", "Готово"]], git: { state: "clean" }, msgs: 3, files: file(["301a1"]) }],
      creds: { bucket: "switchboard-points" },
    });
    expect(api[0].body).toMatchObject({ permission: "object-read-only", prefixes: ["f/"] });
    const [p] = await s.frame({ type: "points.get", id: "g", to: "points", from: "panel", ids: [1] });
    expect((p.result as Record<string, unknown>).creds).toBeUndefined();
    expect(await s.frame({ type: "points.get", id: "g", to: "points", from: "panel", ids: [1, 9] })).toEqual([
      { type: "reply", id: "g", ok: false, error: "no_point", ids: [9], to: "panel" },
    ]);
  });

  it("API Cloudflare отказал — r2_failed, ответ Cloudflare в журнале", async () => {
    const s = fresh();
    fakeCf(403);
    const lines: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation((x: unknown) => void lines.push(JSON.parse(String(x))));
    expect(await s.frame({ type: "points.creds", id: "c", to: "points", from: "@laptop" })).toEqual([{ type: "reply", id: "c", ok: false, error: "r2_failed", to: "@laptop" }]);
    expect(lines).toContainEqual(expect.objectContaining({ part: "points", word: "r2_failed", status: 403 }));
    expect(JSON.stringify(lines)).toContain("Authentication error");
  });

  it("откат на той же машине — голова от base, ledger.add session.rolled_back; ветка «до отката» в списке", async () => {
    const s = fresh();
    await inR2("302a1");
    await line(s, "@pc", "s302", 4, ["302a1"]);
    const out = await put(s, "@pc", "s302", file(["302a1"], 2), { why: "raise", base: 2, expect: "pc" });
    expect(out[0]).toMatchObject({ ok: true, result: { id: 5 } });
    expect(out[1]).toMatchObject({ type: "ledger.add", ev: "session.rolled_back", machine: "pc", text: "site@pc откатана к точке 2" });
    const [l] = await s.frame({ type: "points.list", id: "l", to: "points", from: "panel", sid: "s302" });
    const r = l.result as { owner: string; head: number; points: Array<{ id: number; line: boolean; until: number | null }> };
    expect([r.owner, r.head]).toEqual(["pc", 5]);
    expect(r.points.map((p) => [p.id, p.line])).toEqual([[5, true], [4, false], [3, false], [2, true], [1, true]]);
    expect(r.points[0].until).toBeNull();
    expect(r.points[1].until).toBe(T0 + 365 * DAY);
  });

  it("обзор флота: сессии, место в R2, итог уборки", async () => {
    const s = fresh();
    await inR2("303a1", "303b7");
    await put(s, "@laptop", "s303", file(["303a1", "303b7"]), { dir: "~/x" });
    await sweep(s);
    const [l] = await s.frame({ type: "points.list", id: "l", to: "points", from: "panel" });
    expect(l.result).toEqual({
      sessions: [{ sid: "s303", callsign: "site@laptop", dir: "~/x", owner: "laptop", head: { id: 1, at: T0 }, points: 1, branches: 0 }],
      r2: { bytes: 20, blocks: 2 },
      sweep: { at: T0, blocks: 0, bytes: 0 },
    });
  });

  it("points.delete от машины, которая не хозяин, — not_owner; файлы точки не по контракту — bad_frame", async () => {
    const s = fresh();
    await inR2("304a1");
    await put(s, "@laptop", "s304", file(["304a1"]));
    expect(await s.frame({ type: "points.delete", id: "d", to: "points", from: "@mac", sid: "s304" })).toEqual([
      { type: "reply", id: "d", ok: false, error: "not_owner", owner: "laptop", to: "@mac" },
    ]);
    expect(await put(s, "@laptop", "s304", [{ p: "x", size: 1, b: ["../etc"] }])).toMatchObject([{ ok: false, error: "bad_frame" }]);
    expect(await put(s, "panel", "s304", file(["304a1"]))).toMatchObject([{ ok: false, error: "bad_frame" }]);
    expect(await s.frame({ type: "points.drop", id: "d", to: "points", from: "panel" })).toMatchObject([{ ok: false, error: "unknown_request" }]);
  });

  it("через вход участника: reply и ledger.add уходят в relay по привязке с именем points", async () => {
    await inR2("305a1");
    await relay.frame({ type: "points.put", id: "p-1", to: "points", from: "@laptop", sid: "s305", why: "rule", files: file(["305a1"]) });
    await relay.frame({ type: "points.put", id: "p-2", to: "points", from: "@pc", sid: "s305", why: "raise", base: (await lastId()) ?? 0, expect: "laptop", files: file(["305a1"]) });
    const sent = await env.RELAY_LOG.take();
    expect(sent.map((x) => x.name)).toEqual(["points", "points", "points"]);
    expect(sent.map((x) => [x.frame.type, x.frame.to])).toEqual([
      ["reply", "@laptop"],
      ["reply", "@pc"],
      ["ledger.add", "ledger"],
    ]);
  });
});

async function lastId(): Promise<number | undefined> {
  const home = env.REGISTRY.get(env.REGISTRY.idFromName("home"));
  return runInDurableObject(home, (_o, st) => (st.storage.sql.exec("SELECT MAX(id) AS n FROM points WHERE sid = 's305'").one() as { n: number }).n);
}
