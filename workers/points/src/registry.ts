// Реестр точек: кадры контракта над базой D1. Байтов Worker не видит: машина носит блоки по подписанным ссылкам.
import { accepts, fail, kindOf, ok, type Frame } from "@switchboard/protocol";
import { presign } from "@switchboard/release";
import type { LedgerAdd } from "@switchboard/ledger";
import { CONTRACT, type ListedPoint, type Point, type PointFile, type Why } from "../contract.ts";
import type { Env } from "./env.ts";
import { expiries, lineOf, type Node, survivingBase, YEAR } from "./retention.ts";

/** Строка журнала Worker'а: без ключей и ссылок. */
const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "points", ...line }));

/** Отказ словом контракта и поля к нему. */
class Refused extends Error {
  readonly word: string;
  readonly extra: Record<string, unknown>;
  constructor(word: string, why: string, extra: Record<string, unknown> = {}) {
    super(why);
    this.word = word;
    this.extra = extra;
  }
}
const badFrame = (why: string) => new Refused("bad_frame", why);

type Row = { id: number; sid: string; machine: string; at: number; why: Why; base: number | null; callsign: string | null; dir: string | null; msgs: number | null; bytes: number | null; git: string | null; files: string; spec: string | null; last: string | null };
type SessionRow = { owner: string; head: number };

const WHY = new Set(["rule", "save", "start", "raise", "yield"]);
const HASH = /^[0-9a-f]{1,64}$/;
const SWEEP_KEY = "sweep";
const R2_DELETE_MAX = 1000;

const pointRow = (env: Env, id: number) => env.DB.prepare("SELECT * FROM points WHERE id = ?").bind(id).first<Row>();
const sessionRow = (env: Env, sid: string) => env.DB.prepare("SELECT owner, head FROM sessions WHERE sid = ?").bind(sid).first<SessionRow>();
const shortName = (callsign: string | null | undefined, sid = "") => callsign?.split("@")[0] ?? sid.slice(0, 8);
const notOwner = (owner: string) => new Refused("not_owner", `хозяин сессии — ${owner}`, { owner });

/** Поля строки, которые есть: пустых в ответ не кладём; JSON-поля разобраны. */
function present(r: Row) {
  const parsed = (x: string | null) => (x === null ? undefined : JSON.parse(x));
  const fields = { callsign: r.callsign, dir: r.dir, msgs: r.msgs, bytes: r.bytes };
  return { ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null)), ...(r.git === null ? {} : { git: parsed(r.git) }) } as Pick<Point, "callsign" | "dir" | "msgs" | "bytes" | "git">;
}

const toPoint = (r: Row): Point => ({
  id: r.id,
  sid: r.sid,
  machine: r.machine,
  at: r.at,
  why: r.why,
  base: r.base,
  files: JSON.parse(r.files) as PointFile[],
  ...present(r),
  ...(r.spec === null ? {} : { spec: JSON.parse(r.spec) as Record<string, unknown> }),
  ...(r.last === null ? {} : { last: JSON.parse(r.last) as unknown[] }),
});

/** Ссылки на блоки: один метод, час. */
async function linksOf(env: Env, method: "GET" | "PUT", hashes: string[]): Promise<Record<string, string>> {
  const key = { accessKeyId: env.R2_KEY_ID, secretAccessKey: env.R2_KEY_SECRET };
  const host = `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now = new Date();
  const links = await Promise.all(hashes.map((h) => presign(key, { method, host, path: `/${env.POINTS_BUCKET}/f/${h}`, now })));
  return Object.fromEntries(hashes.map((h, i) => [h, links[i]]));
}

/** Строка журнала флота: не ушла — запись в журнале Worker'а, точка всё равно стоит. */
async function record(env: Env, line: Omit<LedgerAdd, "type" | "v" | "to"> & { by?: string }): Promise<void> {
  const frame = { type: "ledger.add", v: 1, to: ".ledger", from: ".points", ...line } as Frame;
  await env.LEDGER.frame(frame).catch((e: unknown) => log({ kind: "refuse", ev: "ledger.add", word: "offline", why: `${line.text}: ${String(e)}` }));
}

function checkPut(f: Frame): { sid: string; why: Why; files: PointFile[]; base: number | undefined } {
  const { sid, why, files, base } = f;
  if (typeof sid !== "string" || !sid) throw badFrame("points.put без sid");
  if (typeof why !== "string" || !WHY.has(why)) throw badFrame(`points.put: неизвестный повод ${String(why)}`);
  const good = (x: PointFile) => typeof x?.p === "string" && !!x.p && Number.isInteger(x.size) && x.size >= 0 && Array.isArray(x.b) && x.b.every((h) => typeof h === "string" && HASH.test(h));
  if (!Array.isArray(files) || !files.length || !files.every(good)) throw badFrame("points.put: файлы не по контракту");
  if (base !== undefined && (!Number.isInteger(base) || (base as number) < 1)) throw badFrame("points.put: base — номер точки");
  if (why === "raise" && base === undefined) throw badFrame("points.put: подъём без base");
  return { sid, why: why as Why, files: files as PointFile[], base: base as number | undefined };
}

/** Каких блоков нет: база знает размер принятых; остальные спрашиваем у R2. Найденные — со своими размерами. */
async function blocksOf(env: Env, files: PointFile[]): Promise<{ missing: string[]; found: Array<{ hash: string; size: number }> }> {
  const hashes = [...new Set(files.flatMap((x) => x.b))];
  const known = await env.DB.prepare("SELECT hash FROM blocks WHERE hash IN (SELECT value FROM json_each(?))").bind(JSON.stringify(hashes)).all<{ hash: string }>();
  const have = new Set(known.results.map((r) => r.hash));
  const fresh = hashes.filter((h) => !have.has(h));
  const heads = await Promise.all(fresh.map((h) => env.BUCKET.head(`f/${h}`)));
  return {
    missing: fresh.filter((_, i) => !heads[i]),
    found: fresh.flatMap((hash, i) => (heads[i] ? [{ hash, size: heads[i].size }] : [])),
  };
}

async function put(env: Env, f: Frame, from: string) {
  if (kindOf(from) !== "machine") throw badFrame("точку шлёт только машина");
  const machine = from.slice(1);
  const { sid, why, files, base } = checkPut(f);
  const s = await sessionRow(env, sid);
  const from_ = base === undefined ? null : await pointRow(env, base);
  if (base !== undefined && !from_) throw new Refused("no_point", `точки ${base} нет`, { ids: [base] });
  if (from_ && from_.sid !== sid && (s || f.expect !== undefined)) throw badFrame(`точка ${base} — другой сессии`);
  if (s) {
    if (why === "raise" && f.expect !== s.owner) throw notOwner(s.owner);
    if (why !== "raise" && why !== "yield" && machine !== s.owner) throw notOwner(s.owner);
  }

  const yielding = why === "yield" && !!s;
  const own = yielding ? await env.DB.prepare("SELECT * FROM points WHERE sid = ? AND machine = ? ORDER BY id DESC LIMIT 1").bind(sid, machine).first<Row>() : null;
  const near = yielding ? own : s && why !== "raise" ? await pointRow(env, s.head) : null;
  const text = JSON.stringify(files);
  if (near && near.files === text) return { id: near.id, same: true as const };

  const { missing, found } = await blocksOf(env, files);
  if (missing.length) throw new Refused("missing", `блоков нет: ${missing.length}`, { missing, links: await linksOf(env, "PUT", missing) });

  const json = (x: unknown) => (x === undefined ? null : JSON.stringify(x));
  const value = (x: unknown) => (x === undefined ? null : x);
  const parent = yielding ? (own?.id ?? null) : (base ?? s?.head ?? null);
  const hashes = JSON.stringify([...new Set(files.flatMap((x) => x.b))]);
  const newest = "(SELECT MAX(id) FROM points)";
  const statements = [
    env.DB.prepare("INSERT INTO points (sid, machine, at, why, base, callsign, dir, msgs, bytes, git, files, spec, last) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id").bind(sid, machine, Date.now(), why, parent, value(f.callsign), value(f.dir), value(f.msgs), value(f.bytes), json(f.git), text, json(f.spec), json(f.last)),
    ...found.map((b) => env.DB.prepare("INSERT OR IGNORE INTO blocks (hash, size) VALUES (?, ?)").bind(b.hash, b.size)),
    env.DB.prepare(`INSERT OR IGNORE INTO refs (point, hash) SELECT ${newest}, value FROM json_each(?)`).bind(hashes),
    ...(yielding ? [] : [env.DB.prepare(`INSERT INTO sessions (sid, owner, head) VALUES (?, ?, ${newest}) ON CONFLICT (sid) DO UPDATE SET owner = excluded.owner, head = excluded.head`).bind(sid, machine)]),
  ];
  const [inserted] = await env.DB.batch<{ id: number }>(statements);
  const id = inserted.results[0].id;

  const who = { machine, ...(typeof f.callsign === "string" ? { callsign: f.callsign } : {}), ...(typeof f.by === "string" ? { by: f.by } : {}) };
  if (!s && from_) await record(env, { ...who, ev: "session.copied", text: `${shortName(from_.callsign)} → ${String(f.callsign)} · из точки ${base}` });
  else if (s && why === "raise" && s.owner !== machine) await record(env, { ...who, ev: "session.moved", text: `${shortName(f.callsign as string, sid)}: ${s.owner} → ${machine} · из точки ${base}` });
  else if (s && why === "raise" && base !== s.head) await record(env, { ...who, ev: "session.rolled_back", text: `${String(f.callsign)} откатана к точке ${base}` });
  return { id };
}

async function get(env: Env, f: Frame, from: string) {
  const ids = f.ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isInteger)) throw badFrame("points.get: ids — номера точек");
  const rows = await env.DB.prepare("SELECT * FROM points WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<Row>();
  const known = new Set(rows.results.map((r) => r.id));
  const absent = (ids as number[]).filter((id) => !known.has(id));
  if (absent.length) throw new Refused("no_point", `точек нет: ${absent.join(", ")}`, { ids: absent });
  const points = rows.results.map(toPoint);
  const s = await sessionRow(env, points[0].sid);
  const hashes = [...new Set(points.flatMap((p) => p.files.flatMap((x) => x.b)))];
  return { owner: s?.owner ?? null, points, ...(kindOf(from) === "machine" ? { links: await linksOf(env, "GET", hashes) } : {}) };
}

async function listSession(env: Env, sid: string) {
  const s = await sessionRow(env, sid);
  if (!s) return { owner: null, head: null, points: [] };
  const rows = (await env.DB.prepare("SELECT * FROM points WHERE sid = ? ORDER BY id DESC").bind(sid).all<Row>()).results;
  const line = lineOf(rows, s.head);
  const until = expiries(rows, s.head);
  const points: ListedPoint[] = rows.map((r) => ({ id: r.id, machine: r.machine, at: r.at, why: r.why, base: r.base, ...present(r), line: line.has(r.id), until: until.get(r.id) ?? null }));
  return { owner: s.owner, head: s.head, points };
}

async function listFleet(env: Env) {
  const [sessions, r2, sweepRow] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT s.sid, s.owner, h.id, h.at, h.callsign, h.dir,
      (SELECT COUNT(*) FROM points p WHERE p.sid = s.sid) AS points,
      (SELECT COUNT(*) FROM points p WHERE p.sid = s.sid AND p.id <> s.head AND NOT EXISTS (SELECT 1 FROM points c WHERE c.base = p.id)) AS branches
      FROM sessions s JOIN points h ON h.id = s.head ORDER BY h.at DESC`),
    env.DB.prepare("SELECT COUNT(*) AS blocks, COALESCE(SUM(size), 0) AS bytes FROM blocks"),
    env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(SWEEP_KEY),
  ]);
  return {
    sessions: sessions.results.map((r) => ({
      sid: r.sid,
      ...(r.callsign === null ? {} : { callsign: r.callsign }),
      ...(r.dir === null ? {} : { dir: r.dir }),
      owner: r.owner,
      head: { id: r.id, at: r.at },
      points: r.points,
      branches: r.branches,
    })),
    r2: r2.results[0],
    sweep: sweepRow.results.length ? JSON.parse(sweepRow.results[0].v as string) : null,
  };
}

/** Блоки без ссылок уходят из R2 и из базы; чужие объекты бакета база не знает и не трогает. */
async function dropOrphans(env: Env): Promise<{ blocks: number; bytes: number }> {
  const { results } = await env.DB.prepare("SELECT hash, size FROM blocks b WHERE NOT EXISTS (SELECT 1 FROM refs r WHERE r.hash = b.hash)").all<{ hash: string; size: number }>();
  for (let i = 0; i < results.length; i += R2_DELETE_MAX) await env.BUCKET.delete(results.slice(i, i + R2_DELETE_MAX).map((b) => `f/${b.hash}`));
  if (results.length) await env.DB.prepare("DELETE FROM blocks WHERE hash IN (SELECT value FROM json_each(?))").bind(JSON.stringify(results.map((b) => b.hash))).run();
  return { blocks: results.length, bytes: results.reduce((sum, b) => sum + b.size, 0) };
}

async function remove(env: Env, f: Frame, from: string) {
  const sid = f.sid;
  if (typeof sid !== "string" || !sid) throw badFrame("points.delete без sid");
  const s = await sessionRow(env, sid);
  if (!s) return { points: 0, blocks: 0, bytes: 0 };
  if (kindOf(from) === "machine" && from.slice(1) !== s.owner) throw notOwner(s.owner);
  const head = await pointRow(env, s.head);
  const [counted] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM points WHERE sid = ?").bind(sid),
    env.DB.prepare("DELETE FROM refs WHERE point IN (SELECT id FROM points WHERE sid = ?)").bind(sid),
    env.DB.prepare("DELETE FROM points WHERE sid = ?").bind(sid),
    env.DB.prepare("DELETE FROM sessions WHERE sid = ?").bind(sid),
  ]);
  const points = counted.results[0].n;
  const freed = await dropOrphans(env);
  const by = typeof f.by === "string" ? f.by : from;
  log({ kind: "note", ev: "points.delete", sid, by, points, ...freed });
  await record(env, { ev: "session.deleted", text: `${shortName(head?.callsign, sid)} удалена из R2 · ${points} точек`, machine: s.owner, ...(head?.callsign ? { callsign: head.callsign } : {}), by });
  return { points, ...freed };
}

const REQUESTS: Record<keyof typeof CONTRACT, (env: Env, f: Frame, from: string) => Promise<unknown>> = {
  "points.put": put,
  "points.get": get,
  "points.list": (env, f) => (typeof f.sid === "string" ? listSession(env, f.sid) : listFleet(env)),
  "points.delete": remove,
};

/** Кадр с to: ".points" → кадры в ответ вызывающему. Неверный вход — слово и строка журнала. */
export async function answer(env: Env, f: Frame): Promise<Frame[]> {
  const from = f.from ?? "";
  const refused = (word: string, why: string, extra: Record<string, unknown> = {}): Frame[] => {
    log({ kind: "refuse", ev: f.type, word, why, from });
    return f.id ? [{ ...fail(f.id, word), ...extra, to: from }] : [];
  };
  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", from, why: "points ответов не ждёт" });
    return [];
  }
  const request = REQUESTS[f.type as keyof typeof CONTRACT];
  if (!request) return refused("unknown_request", `points не обслуживает ${f.type}`);
  const version = accepts(f, CONTRACT);
  if (version) return refused(version.word, version.why);
  if (!f.id) return refused("bad_frame", `${f.type} без id — ответить некому`);
  try {
    return [{ ...ok(f.id, await request(env, f, from)), to: from }];
  } catch (e) {
    if (e instanceof Refused) return refused(e.word, e.message, e.extra);
    throw e;
  }
}

/** Уборка раз в сутки: правило хранения, затем блоки без ссылок. Итог — в обзоре и журнале. */
export async function sweep(env: Env): Promise<void> {
  const now = Date.now();
  const [rows, sessions] = await env.DB.batch<Record<string, unknown>>([env.DB.prepare("SELECT id, sid, at, base FROM points"), env.DB.prepare("SELECT sid, head FROM sessions")]);
  const bySid = new Map<string, Node[]>();
  for (const r of rows.results as Array<Node & { sid: string }>) bySid.set(r.sid, [...(bySid.get(r.sid) ?? []), r]);

  const gone = new Set<number>();
  const statements: D1PreparedStatement[] = [];
  for (const { sid, head } of sessions.results as Array<{ sid: string; head: number }>) {
    const nodes = bySid.get(sid) ?? [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    if ((byId.get(head)?.at ?? 0) + YEAR <= now) {
      for (const n of nodes) gone.add(n.id);
      statements.push(env.DB.prepare("DELETE FROM sessions WHERE sid = ?").bind(sid));
      continue;
    }
    const expired = new Set([...expiries(nodes, head)].filter(([, until]) => until !== null && until <= now).map(([id]) => id));
    for (const id of expired) gone.add(id);
    for (const n of nodes) {
      if (!expired.has(n.id) && n.base !== null && expired.has(n.base)) statements.push(env.DB.prepare("UPDATE points SET base = ? WHERE id = ?").bind(survivingBase(n, byId, expired), n.id));
    }
  }
  const ids = JSON.stringify([...gone]);
  await env.DB.batch([
    ...statements,
    env.DB.prepare("DELETE FROM refs WHERE point IN (SELECT value FROM json_each(?))").bind(ids),
    env.DB.prepare("DELETE FROM points WHERE id IN (SELECT value FROM json_each(?))").bind(ids),
  ]);
  const freed = await dropOrphans(env);
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind(SWEEP_KEY, JSON.stringify({ at: now, ...freed })).run();
  log({ kind: "note", ev: "sweep", points: gone.size, ...freed });
}
