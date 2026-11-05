// Реестр точек: кадр → запрос в D1 → ответ. Байтов точек Worker не видит: блоки машина кладёт и берёт по ссылкам.
import { accepts, fail, kindOf, machineOf, nameOf, ok, within, type Frame } from "@switchboard/protocol";
import { presign } from "@switchboard/release";
import { CONTRACT, type Point, type PointFile, type Why } from "../contract.ts";
import type { Env } from "./env.ts";
import { expiries, lineOf, YEAR, type Node } from "./retention.ts";

/** Отказ словом: reply — поля ответа рядом со словом. */
class Refusal extends Error {
  word: string;
  reply: Record<string, unknown>;
  constructor(word: string, why: string, reply: Record<string, unknown> = {}) {
    super(why);
    this.word = word;
    this.reply = reply;
  }
}

/** Журнал — Workers Logs, строка JSON в общем формате журналов. Ключей здесь нет. */
const log = (row: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "points", ...row }));

type Row = { id: number; sid: string; machine: string; at: number; why: Why; base: number | null; callsign: string | null; dir: string | null; msgs: number | null; bytes: number | null; git: string | null; files: string; spec: string | null; last: string | null };
type SessionRow = { owner: string; head: number };

const WHY = new Set(["rule", "save", "start", "raise", "yield"]);
const HASH = /^[0-9a-f]{1,64}$/;
const R2_BATCH = 1000;

const key = (hash: string) => `f/${hash}`;
const link = (env: Env, method: "GET" | "PUT", hash: string) =>
  presign({ accessKeyId: env.R2_KEY_ID, secretAccessKey: env.R2_KEY_SECRET }, { method, host: `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`, path: `/${env.POINTS_BUCKET}/${key(hash)}` });
const links = async (env: Env, method: "GET" | "PUT", hashes: string[]) => Object.fromEntries(await Promise.all(hashes.map(async (h) => [h, await link(env, method, h)])));

const hashesOf = (files: PointFile[]) => [...new Set(files.flatMap((f) => f.b))];
const present = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const parsed = (text: string | null) => (text === null ? undefined : JSON.parse(text));
const isInt = (x: unknown): x is number => Number.isInteger(x);

const sessionOf = (db: D1Database, sid: string) => db.prepare("SELECT owner, head FROM sessions WHERE sid = ?").bind(sid).first<SessionRow>();
const pointOf = (db: D1Database, id: number) => db.prepare("SELECT * FROM points WHERE id = ?").bind(id).first<Row>();

/** Строка журнала флота. Журнал не ответил — строка Worker'а: точка уже лежит. */
async function ledger(env: Env, row: { ev: string; text: string; machine: string; callsign?: string; by?: unknown }) {
  const { by, ...rest } = row;
  const line = { type: "ledger.add", v: 1, to: ".ledger", from: ".points", ...rest, ...(by ? { by } : {}) };
  await within(env.LEDGER.frame(line), "журнал флота не ответил").catch((e) => log({ kind: "note", ev: "ledger", why: String(e) }));
}

/** Блоки без единой ссылки уходят из R2 и из реестра; чужих объектов бакета уборка не знает. */
async function dropOrphans(env: Env): Promise<{ blocks: number; bytes: number }> {
  const { results } = await env.DB.prepare("SELECT hash, size FROM blocks WHERE hash NOT IN (SELECT hash FROM refs)").all<{ hash: string; size: number }>();
  const hashes = results.map((r) => r.hash);
  for (let i = 0; i < hashes.length; i += R2_BATCH) await env.BUCKET.delete(hashes.slice(i, i + R2_BATCH).map(key));
  await env.DB.prepare("DELETE FROM blocks WHERE hash IN (SELECT value FROM json_each(?))").bind(JSON.stringify(hashes)).run();
  return { blocks: hashes.length, bytes: results.reduce((n, r) => n + r.size, 0) };
}

function checkPut(f: Frame): { machine: string; sid: string; why: Why; files: PointFile[]; base?: number } {
  const { from, sid, why, files, base } = f;
  const good = (x: PointFile) => typeof x?.p === "string" && isInt(x.size) && Array.isArray(x.b) && x.b.every((h) => HASH.test(h));
  if (kindOf(from) !== "machine") throw new Refusal("bad_frame", "точку кладёт только машина");
  if (typeof sid !== "string" || !sid) throw new Refusal("bad_frame", "нет sid");
  if (!WHY.has(why as string)) throw new Refusal("bad_frame", `повод ${why}`);
  if (!Array.isArray(files) || !files.length || !files.every(good)) throw new Refusal("bad_frame", "файлы не по контракту");
  if (base !== undefined && !isInt(base)) throw new Refusal("bad_frame", "base — не номер точки");
  if (why === "raise" && base === undefined) throw new Refusal("bad_frame", "подъём без base");
  return { machine: machineOf(from as string)!, sid, why: why as Why, files, base };
}

/** Каких блоков нет в реестре и в R2; те, что нашлись в R2, — новые строки блоков. */
async function blocksOf(env: Env, hashes: string[]) {
  const { results } = await env.DB.prepare("SELECT hash FROM blocks WHERE hash IN (SELECT value FROM json_each(?))").bind(JSON.stringify(hashes)).all<{ hash: string }>();
  const known = new Set(results.map((r) => r.hash));
  const heads = await Promise.all(hashes.filter((h) => !known.has(h)).map(async (hash) => ({ hash, object: await env.BUCKET.head(key(hash)) })));
  return { missing: heads.filter((x) => !x.object).map((x) => x.hash), fresh: heads.flatMap((x) => (x.object ? [{ hash: x.hash, size: x.object.size }] : [])) };
}

const REQUESTS: Record<keyof typeof CONTRACT, (env: Env, f: Frame) => Promise<unknown>> = {
  async "points.put"(env, f) {
    const { machine, sid, why, files, base } = checkPut(f);
    const db = env.DB;
    const session = await sessionOf(db, sid);
    const from = base === undefined ? null : await pointOf(db, base);
    if (base !== undefined && !from) throw new Refusal("no_point", `точки ${base} нет`, { ids: [base] });
    if (session && from && from.sid !== sid) throw new Refusal("bad_frame", `точка ${base} — другой сессии`);
    const owner = why === "raise" ? f.expect : why === "yield" ? session?.owner : machine;
    if (session && owner !== session.owner) throw new Refusal("not_owner", `хозяин ${sid} — ${session.owner}`, { owner: session.owner });

    // от чего идёт точка: отдающая сессию машина — от своей последней, остальные — от головы
    const own = why === "yield" ? await db.prepare("SELECT * FROM points WHERE sid = ? AND machine = ? ORDER BY id DESC LIMIT 1").bind(sid, machine).first<Row>() : session && (await pointOf(db, session.head));
    const text = JSON.stringify(files);
    if (why !== "raise" && own?.files === text) return { id: own.id, same: true };

    const { missing, fresh } = await blocksOf(env, hashesOf(files));
    if (missing.length) throw new Refusal("missing", `нет блоков: ${missing.length}`, { missing, links: await links(env, "PUT", missing) });

    const json = (x: unknown) => (x === undefined ? null : JSON.stringify(x));
    const value = (x: unknown) => x ?? null;
    const [, inserted] = await db.batch<{ id: number }>([
      db.prepare("INSERT OR IGNORE INTO blocks (hash, size) SELECT json_extract(value, '$.hash'), json_extract(value, '$.size') FROM json_each(?)").bind(JSON.stringify(fresh)),
      db
        .prepare("INSERT INTO points (sid, machine, at, why, base, callsign, dir, msgs, bytes, git, files, spec, last) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .bind(sid, machine, Date.now(), why, base ?? own?.id ?? null, value(f.callsign), value(f.dir), value(f.msgs), value(f.bytes), json(f.git), text, json(f.spec), json(f.last)),
      db.prepare("INSERT INTO refs (point, hash) SELECT (SELECT MAX(id) FROM points), value FROM json_each(?)").bind(JSON.stringify(hashesOf(files))),
      ...(why === "yield" ? [] : [db.prepare("INSERT INTO sessions (sid, owner, head) VALUES (?, ?, (SELECT MAX(id) FROM points)) ON CONFLICT (sid) DO UPDATE SET owner = excluded.owner, head = excluded.head").bind(sid, machine)]),
    ]);

    const shown = f.callsign ?? sid;
    const event = { machine, callsign: f.callsign, by: f.by };
    if (!session && from) await ledger(env, { ...event, ev: "session.copied", text: `${nameOf(from.callsign ?? from.sid)} → ${shown} · из точки ${base}` });
    else if (session && why === "raise" && session.owner !== machine) await ledger(env, { ...event, ev: "session.moved", text: `${nameOf(shown)}: ${session.owner} → ${machine} · из точки ${base}` });
    else if (session && why === "raise" && base !== session.head) await ledger(env, { ...event, ev: "session.rolled_back", text: `${shown} откатана к точке ${base}` });
    return { id: inserted.results[0].id };
  },

  async "points.get"(env, f) {
    const { ids, from } = f;
    if (!Array.isArray(ids) || !ids.length || !ids.every(isInt)) throw new Refusal("bad_frame", "ids — не номера точек");
    const { results } = await env.DB.prepare("SELECT * FROM points WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<Row>();
    const absent = ids.filter((id) => !results.some((r) => r.id === id));
    if (absent.length) throw new Refusal("no_point", `нет точек: ${absent.join(", ")}`, { ids: absent });
    const points = results.map(toPoint);
    const session = await sessionOf(env.DB, points[0].sid);
    return { owner: session?.owner, points, ...(kindOf(from) === "machine" ? { links: await links(env, "GET", hashesOf(points.flatMap((p) => p.files))) } : {}) };
  },

  async "points.list"(env, f) {
    return typeof f.sid === "string" ? sessionLine(env.DB, f.sid) : fleet(env.DB);
  },

  async "points.delete"(env, f) {
    const { sid, from } = f;
    if (typeof sid !== "string" || !sid) throw new Refusal("bad_frame", "нет sid");
    const session = await sessionOf(env.DB, sid);
    if (!session) return { points: 0, blocks: 0, bytes: 0 };
    const machine = machineOf(from as string);
    if (kindOf(from) === "machine" && machine !== session.owner) throw new Refusal("not_owner", `хозяин ${sid} — ${session.owner}`, { owner: session.owner });
    const head = await pointOf(env.DB, session.head);
    const [, gone] = await env.DB.batch([
      env.DB.prepare("DELETE FROM refs WHERE point IN (SELECT id FROM points WHERE sid = ?)").bind(sid),
      env.DB.prepare("DELETE FROM points WHERE sid = ?").bind(sid),
      env.DB.prepare("DELETE FROM sessions WHERE sid = ?").bind(sid),
    ]);
    const points = gone.meta.changes;
    const dropped = await dropOrphans(env);
    const callsign = head?.callsign ?? sid;
    await ledger(env, { ev: "session.deleted", text: `${nameOf(callsign)} удалена из R2 · ${points} точек`, machine: session.owner, callsign, by: f.by ?? from });
    return { points, ...dropped };
  },
};

function toPoint(r: Row): Point {
  const { git, files, spec, last, ...rest } = r;
  return { ...present(rest), base: r.base, files: JSON.parse(files), ...present({ git: parsed(git), spec: parsed(spec), last: parsed(last) }) } as Point;
}

async function sessionLine(db: D1Database, sid: string) {
  const session = await sessionOf(db, sid);
  if (!session) return { owner: null, head: null, points: [] };
  const { results } = await db.prepare("SELECT id, machine, at, why, base, callsign, dir, msgs, bytes, git FROM points WHERE sid = ? ORDER BY id DESC").bind(sid).all<Node & Pick<Row, "git">>();
  const line = lineOf(results, session.head);
  const until = expiries(results, session.head);
  const points = results.map(({ git, ...r }) => ({ ...present(r), base: r.base, ...present({ git: parsed(git) }), line: line.has(r.id), until: until.get(r.id) }));
  return { ...session, points };
}

async function fleet(db: D1Database) {
  type Line = { sid: string; owner: string; head: number; at: number; callsign: string | null; dir: string | null; points: number; branches: number };
  const [sessions, r2, sweep] = await Promise.all([
    db.prepare(`SELECT s.sid, s.owner, s.head, h.at, h.callsign, h.dir, COUNT(p.id) AS points,
        SUM(p.id != s.head AND NOT EXISTS (SELECT 1 FROM points c WHERE c.base = p.id AND c.sid = p.sid)) AS branches
      FROM sessions s JOIN points h ON h.id = s.head JOIN points p ON p.sid = s.sid GROUP BY s.sid ORDER BY h.at DESC`).all<Line>(),
    db.prepare("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS blocks FROM blocks").first(),
    db.prepare("SELECT v FROM meta WHERE k = 'sweep'").first<{ v: string }>(),
  ]);
  return {
    sessions: sessions.results.map(({ head, at, ...s }) => ({ ...present(s), head: { id: head, at } })),
    r2,
    sweep: sweep && JSON.parse(sweep.v),
  };
}

/** Кадр → ответ. Отказ — Refusal: строка журнала и ответ со словом здесь; остальное летит дальше, вход отвечает failed. */
export async function frame(env: Env, f: Frame): Promise<Frame[]> {
  const { id, from, type } = f;
  if (type === "reply") {
    log({ kind: "note", ev: "reply", id, from });
    return [];
  }
  try {
    const off = accepts(f, CONTRACT);
    if (off) throw new Refusal(off.word, off.why);
    if (!id) throw new Refusal("bad_frame", `${type} без id — ответить некому`);
    return [{ ...ok(id, await REQUESTS[type as keyof typeof CONTRACT](env, f)), to: from }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    log({ kind: "refuse", ev: type, word: e.word, why: e.message, from });
    return id ? [{ ...fail(id, e.word), ...e.reply, to: from }] : [];
  }
}

/** Уборка: сессия без новых точек год уходит целиком, остальные — по правилу; дети стёртой точки переходят к её живой основе. */
export async function sweep(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const [nodes, sessions] = await db.batch<Node & { sid: string; head: number }>([db.prepare("SELECT id, sid, at, base FROM points"), db.prepare("SELECT sid, head FROM sessions")]);
  const gone: number[] = [];
  const whole: string[] = [];
  const moves: D1PreparedStatement[] = [];
  for (const { sid, head } of sessions.results) {
    const own = nodes.results.filter((n) => n.sid === sid);
    if (now - own.find((n) => n.id === head)!.at >= YEAR) {
      whole.push(sid);
      gone.push(...own.map((n) => n.id));
      continue;
    }
    const until = expiries(own, head);
    const dead = new Map(own.filter((n) => (until.get(n.id) ?? Infinity) <= now).map((n) => [n.id, n]));
    gone.push(...dead.keys());
    for (const n of own) {
      let base = n.base;
      while (base !== null && dead.has(base)) base = dead.get(base)!.base;
      if (!dead.has(n.id) && base !== n.base) moves.push(db.prepare("UPDATE points SET base = ? WHERE id = ?").bind(base, n.id));
    }
  }
  const ids = JSON.stringify(gone);
  await db.batch([
    ...moves,
    db.prepare("DELETE FROM refs WHERE point IN (SELECT value FROM json_each(?))").bind(ids),
    db.prepare("DELETE FROM points WHERE id IN (SELECT value FROM json_each(?))").bind(ids),
    db.prepare("DELETE FROM sessions WHERE sid IN (SELECT value FROM json_each(?))").bind(JSON.stringify(whole)),
  ]);
  const dropped = await dropOrphans(env);
  await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sweep', ?)").bind(JSON.stringify({ at: now, ...dropped })).run();
  log({ kind: "note", ev: "sweep", points: gone.length, ...dropped });
}
