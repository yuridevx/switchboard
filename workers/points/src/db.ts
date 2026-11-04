// База D1 реестра: строки и запросы. Форма таблиц — контракт хранилища, см. migrations.
import type { Point, PointFile, Why } from "../contract.ts";

export type Row = {
  id: number;
  sid: string;
  machine: string;
  at: number;
  why: Why;
  base: number | null;
  callsign: string | null;
  dir: string | null;
  msgs: number | null;
  bytes: number | null;
  git: string | null;
  files: string;
  spec: string | null;
  last: string | null;
};
export type SessionRow = { sid: string; owner: string; head: number };
export type NewPoint = Pick<Row, "sid" | "machine" | "at" | "why" | "base" | "callsign" | "dir" | "msgs" | "bytes" | "git" | "files" | "spec" | "last">;

/** Строка базы → точка контракта: поля без значения не приходят. */
export function toPoint(r: Row): Point {
  const { callsign, dir, msgs, bytes, git, spec, last } = r;
  return {
    id: r.id,
    sid: r.sid,
    machine: r.machine,
    at: r.at,
    why: r.why,
    base: r.base,
    files: JSON.parse(r.files) as PointFile[],
    ...(callsign !== null ? { callsign } : {}),
    ...(dir !== null ? { dir } : {}),
    ...(msgs !== null ? { msgs } : {}),
    ...(bytes !== null ? { bytes } : {}),
    ...(git !== null ? { git: JSON.parse(git) } : {}),
    ...(spec !== null ? { spec: JSON.parse(spec) } : {}),
    ...(last !== null ? { last: JSON.parse(last) } : {}),
  };
}

const each = <T>(db: D1Database, q: string, ...args: Array<string | number>) => db.prepare(q).bind(...args).all<T>().then((r) => r.results);
const first = async <T>(db: D1Database, q: string, ...args: Array<string | number>) => (await db.prepare(q).bind(...args).first<T>()) ?? undefined;

export const session = (db: D1Database, sid: string) => first<SessionRow>(db, "SELECT * FROM sessions WHERE sid = ?", sid);
export const sessions = (db: D1Database) => each<SessionRow>(db, "SELECT * FROM sessions");
export const point = (db: D1Database, id: number) => first<Row>(db, "SELECT * FROM points WHERE id = ?", id);
export const pointsIn = (db: D1Database, ids: number[]) => each<Row>(db, "SELECT * FROM points WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id", JSON.stringify(ids));
export const pointsOf = (db: D1Database, sid: string) => each<Row>(db, "SELECT * FROM points WHERE sid = ? ORDER BY id DESC", sid);
export const lastPointOf = async (db: D1Database, sid: string, machine: string) => (await first<{ id: number | null }>(db, "SELECT MAX(id) AS id FROM points WHERE sid = ? AND machine = ?", sid, machine))?.id ?? null;
export const knownBlocks = async (db: D1Database, hashes: string[]) => new Set((await each<{ hash: string }>(db, "SELECT hash FROM blocks WHERE hash IN (SELECT value FROM json_each(?))", JSON.stringify(hashes))).map((r) => r.hash));

/** Точка, затем её блоки, ссылки и хозяин одной пачкой; moveTo — кому отдать голову. */
export async function insertPoint(db: D1Database, p: NewPoint, blocks: Array<{ hash: string; size: number }>, hashes: string[], moveTo: string | null): Promise<number> {
  const { id } = (await db
    .prepare("INSERT INTO points (sid, machine, at, why, base, callsign, dir, msgs, bytes, git, files, spec, last) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(p.sid, p.machine, p.at, p.why, p.base, p.callsign, p.dir, p.msgs, p.bytes, p.git, p.files, p.spec, p.last)
    .first<{ id: number }>())!;
  await db.batch([
    ...blocks.map((b) => db.prepare("INSERT OR IGNORE INTO blocks (hash, size) VALUES (?, ?)").bind(b.hash, b.size)),
    db.prepare("INSERT OR IGNORE INTO refs (point, hash) SELECT ?, value FROM json_each(?)").bind(id, JSON.stringify(hashes)),
    ...(moveTo !== null ? [db.prepare("INSERT OR REPLACE INTO sessions (sid, owner, head) VALUES (?, ?, ?)").bind(p.sid, moveTo, id)] : []),
  ]);
  return id;
}

export const dropSession = (db: D1Database, sid: string) => db.prepare("DELETE FROM sessions WHERE sid = ?").bind(sid).run();

/** Стереть точки; их дети переходят к основе стёртой: линия и ветки остаются связными. */
export async function dropPoints(db: D1Database, ids: number[]): Promise<void> {
  if (!ids.length) return;
  await db.batch(
    ids.flatMap((id) => [
      db.prepare("UPDATE points SET base = (SELECT base FROM points WHERE id = ?) WHERE base = ?").bind(id, id),
      db.prepare("DELETE FROM refs WHERE point = ?").bind(id),
      db.prepare("DELETE FROM points WHERE id = ?").bind(id),
    ]),
  );
}

export const orphanBlocks = (db: D1Database) => each<{ hash: string; size: number }>(db, "SELECT hash, size FROM blocks WHERE NOT EXISTS (SELECT 1 FROM refs WHERE refs.hash = blocks.hash)");
export const dropBlocks = (db: D1Database, hashes: string[]) => db.prepare("DELETE FROM blocks WHERE hash IN (SELECT value FROM json_each(?))").bind(JSON.stringify(hashes)).run();

export const fleetRows = (db: D1Database) =>
  each<{ sid: string; owner: string; head: number; at: number; callsign: string | null; dir: string | null; n: number; branches: number }>(
    db,
    `SELECT s.sid, s.owner, s.head, h.at, h.callsign, h.dir,
       (SELECT COUNT(*) FROM points p WHERE p.sid = s.sid) AS n,
       (SELECT COUNT(*) FROM points p WHERE p.sid = s.sid AND p.id != s.head AND NOT EXISTS (SELECT 1 FROM points c WHERE c.base = p.id)) AS branches
     FROM sessions s JOIN points h ON h.id = s.head ORDER BY h.at DESC`,
  );
export const blockTotals = async (db: D1Database) => (await first<{ blocks: number; bytes: number }>(db, "SELECT COUNT(*) AS blocks, COALESCE(SUM(size), 0) AS bytes FROM blocks"))!;

export const lastSweep = async (db: D1Database) => {
  const row = await first<{ v: string }>(db, "SELECT v FROM meta WHERE k = 'sweep'");
  return row ? (JSON.parse(row.v) as { at: number; blocks: number; bytes: number }) : null;
};
export const saveSweep = (db: D1Database, sweep: { at: number; blocks: number; bytes: number }) => db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sweep', ?)").bind(JSON.stringify(sweep)).run();
