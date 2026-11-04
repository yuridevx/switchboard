// Реестр точек: хозяин сессии, линия и ветки, какие блоки уже в R2, ссылки машине, уборка и удаление сессии.
import type { LedgerAdd } from "@switchboard/ledger";
import type { Frame } from "@switchboard/protocol";
import { presign } from "@switchboard/release";
import type { ListedPoint, PointFile, Why } from "../contract.ts";
import * as db from "./db.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";
import { expired, expiry, lineOf } from "./retention.ts";

/** Отказ словом: поля ответа (owner, ids, missing, links) и причина для журнала. */
export class Refused extends Error {
  word: string;
  fields: Record<string, unknown>;
  constructor(word: string, why: string, fields: Record<string, unknown> = {}) {
    super(why);
    this.word = word;
    this.fields = fields;
  }
}

const WHY: readonly Why[] = ["rule", "save", "start", "raise", "yield"];
const HASH = /^[0-9a-f]{2,128}$/;
const BATCH = 1000;

const shortName = (callsign: string | null | undefined, sid: string) => (callsign ? callsign.split("@")[0] : sid.slice(0, 8));

function ledgerLine(ev: string, text: string, who: { machine?: string; callsign?: string | null; by?: string }): LedgerAdd {
  const { machine, callsign, by } = who;
  return { type: "ledger.add", v: 1, to: ".ledger", ev, text, ...(machine ? { machine } : {}), ...(callsign ? { callsign } : {}), ...(by ? { by } : {}) };
}

/** Файлы по контракту; порядок полей один — для сравнения «те же файлы». */
function parseFiles(x: unknown): PointFile[] {
  if (!Array.isArray(x) || !x.length) throw new Refused("bad_frame", "files — непустой список");
  return x.map((f: { p?: unknown; size?: unknown; b?: unknown }) => {
    const ok = f && typeof f.p === "string" && typeof f.size === "number" && Array.isArray(f.b) && f.b.every((h) => typeof h === "string" && HASH.test(h));
    if (!ok) throw new Refused("bad_frame", "файл точки — { p, size, b: [отпечатки hex] }");
    return { p: f.p as string, size: f.size as number, b: f.b as string[] };
  });
}

/** Ссылки на блоки f/<отпечаток>: один блок, один метод, час. */
async function links(env: Env, method: "GET" | "PUT", hashes: string[]): Promise<Record<string, string>> {
  const key = { accessKeyId: env.R2_KEY_ID, secretAccessKey: env.R2_KEY_SECRET };
  const host = `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now = new Date();
  const signed = await Promise.all(hashes.map(async (h) => [h, await presign(key, { method, host, path: `/${env.POINTS_BUCKET}/f/${h}`, now })] as const));
  return Object.fromEntries(signed);
}

/** Куда встанет новая точка; same — файлы те же, что у основы: строки не будет. */
type Placement = { base: number | null; moveTo: string | null; line?: LedgerAdd; same?: number };

async function place(env: Env, f: Frame, sid: string, machine: string, stored: string): Promise<Placement> {
  const current = await db.session(env.DB, sid);
  const by = typeof f.by === "string" ? f.by : undefined;
  const callsign = typeof f.callsign === "string" ? f.callsign : undefined;
  const base = typeof f.base === "number" ? f.base : null;
  const need = async (id: number | null) => {
    const row = id === null ? undefined : await db.point(env.DB, id);
    if (!row) throw new Refused("no_point", `точки ${id} нет`, { ids: [id] });
    return row;
  };

  if (!current) {
    if (base === null) return { base, moveTo: machine };
    const from = await need(base);
    return { base, moveTo: machine, line: ledgerLine("session.copied", `${shortName(from.callsign, from.sid)} → ${callsign ?? sid.slice(0, 8)} · из точки ${base}`, { machine, callsign, by }) };
  }

  if (f.why === "raise") {
    if (f.expect !== current.owner) throw new Refused("not_owner", `хозяин ${current.owner}, expect ${String(f.expect)}`, { owner: current.owner });
    const from = await need(base);
    if (from.sid !== sid) throw new Refused("bad_frame", `точка ${base} — не этой сессии`);
    const who = shortName(callsign ?? from.callsign, sid);
    const line =
      current.owner !== machine
        ? ledgerLine("session.moved", `${who}: ${current.owner} → ${machine} · из точки ${base}`, { machine, callsign, by })
        : base !== current.head
          ? ledgerLine("session.rolled_back", `${callsign ?? who} откатана к точке ${base}`, { machine, callsign, by })
          : undefined;
    return { base, moveTo: machine, line };
  }

  // вернувшийся прежний хозяин отдаёт дописанное веткой от своей последней точки; голова остаётся у нового
  const yielding = machine !== current.owner;
  if (yielding && f.why !== "yield") throw new Refused("not_owner", `хозяин ${current.owner}`, { owner: current.owner });
  const from = yielding ? await db.lastPointOf(env.DB, sid, machine) : current.head;
  const unchanged = from !== null && (await db.point(env.DB, from))?.files === stored;
  return { base: from, moveTo: yielding ? null : machine, same: unchanged ? from! : undefined };
}

async function put(env: Env, f: Frame, machine: string): Promise<{ result: Record<string, unknown>; line?: LedgerAdd }> {
  const sid = f.sid;
  if (typeof sid !== "string" || !sid) throw new Refused("bad_frame", "нет sid");
  if (!WHY.includes(f.why as Why)) throw new Refused("bad_frame", `why — одно из ${WHY.join(", ")}`);
  const files = parseFiles(f.files);
  if (f.base !== undefined && !Number.isInteger(f.base)) throw new Refused("bad_frame", "base — номер точки");
  if (f.why === "raise" && f.base === undefined) throw new Refused("bad_frame", "у raise нет base");
  const stored = JSON.stringify(files);

  // хозяин — до похода в R2: не просить блоки у того, чью точку реестр не примет
  const early = await place(env, f, sid, machine, stored);
  if (early.same !== undefined) return { result: { id: early.same, same: true } };

  // блок есть, если он в базе или лежит в бакете: машина положила его, а точку ещё не прислала
  const hashes = [...new Set(files.flatMap((x) => x.b))];
  const known = await db.knownBlocks(env.DB, hashes);
  const fresh = await Promise.all(hashes.filter((h) => !known.has(h)).map(async (hash) => ({ hash, object: await env.BUCKET.head(`f/${hash}`) })));
  const missing = fresh.filter((x) => !x.object).map((x) => x.hash);
  if (missing.length) throw new Refused("missing", `${missing.length} блоков нет в R2`, { missing, links: await links(env, "PUT", missing) });

  // за время похода в R2 хозяин мог смениться: решение заново
  const final = await place(env, f, sid, machine, stored);
  if (final.same !== undefined) return { result: { id: final.same, same: true } };
  const json = (x: unknown) => (x === undefined ? null : JSON.stringify(x));
  const num = (x: unknown) => (typeof x === "number" ? x : null);
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  const id = await db.insertPoint(
    env.DB,
    { sid, machine, at: Date.now(), why: f.why as Why, base: final.base, callsign: str(f.callsign), dir: str(f.dir), msgs: num(f.msgs), bytes: num(f.bytes), git: json(f.git), files: stored, spec: json(f.spec), last: json(f.last) },
    fresh.map((x) => ({ hash: x.hash, size: x.object!.size })),
    hashes,
    final.moveTo,
  );
  log({ kind: "note", ev: "points.put", from: machine, sid, point: id, why: f.why, base: final.base, blocks: hashes.length });
  return { result: { id }, line: final.line };
}

async function get(env: Env, f: Frame, machine: string | null): Promise<Record<string, unknown>> {
  const ids = f.ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => Number.isInteger(x))) throw new Refused("bad_frame", "ids — непустой список номеров");
  const rows = await db.pointsIn(env.DB, ids as number[]);
  const lost = (ids as number[]).filter((x) => !rows.some((r) => r.id === x));
  if (lost.length) throw new Refused("no_point", `точек ${lost.join(", ")} нет`, { ids: lost });
  const owner = (await db.session(env.DB, rows[0].sid))?.owner ?? null;
  const points = rows.map(db.toPoint);
  // блоки нужны только машине
  return { owner, points, ...(machine ? { links: await links(env, "GET", [...new Set(points.flatMap((p) => p.files.flatMap((x) => x.b)))]) } : {}) };
}

async function listSession(env: Env, sid: string) {
  const current = await db.session(env.DB, sid);
  if (!current) return { owner: null, head: null, points: [] };
  const rows = await db.pointsOf(env.DB, sid);
  const line = lineOf(rows, current.head);
  const until = expiry(rows, current.head);
  const points: ListedPoint[] = rows.map((r) => {
    const { files: _f, spec: _s, last: _l, sid: _sid, ...rest } = db.toPoint(r);
    return { ...rest, line: line.has(r.id), until: until.get(r.id) ?? null };
  });
  return { owner: current.owner, head: current.head, points };
}

async function listFleet(env: Env) {
  const [rows, r2, sweepAt] = await Promise.all([db.fleetRows(env.DB), db.blockTotals(env.DB), db.lastSweep(env.DB)]);
  const sessions = rows.map((r) => ({
    sid: r.sid,
    ...(r.callsign !== null ? { callsign: r.callsign } : {}),
    ...(r.dir !== null ? { dir: r.dir } : {}),
    owner: r.owner,
    head: { id: r.head, at: r.at },
    points: r.n,
    branches: r.branches,
  }));
  return { sessions, r2: { bytes: r2.bytes, blocks: r2.blocks }, sweep: sweepAt };
}

/** Блоки без ссылок: сначала из R2, затем из базы — оборвалось посередине, следующий раз доделает. */
async function collectOrphans(env: Env): Promise<{ blocks: number; bytes: number }> {
  const orphans = await db.orphanBlocks(env.DB);
  for (let i = 0; i < orphans.length; i += BATCH) {
    const part = orphans.slice(i, i + BATCH);
    await env.BUCKET.delete(part.map((b) => `f/${b.hash}`));
    await db.dropBlocks(env.DB, part.map((b) => b.hash));
  }
  return { blocks: orphans.length, bytes: orphans.reduce((n, b) => n + b.size, 0) };
}

async function remove(env: Env, sid: string, machine: string | null, by: string): Promise<{ result: Record<string, unknown>; line?: LedgerAdd }> {
  const current = await db.session(env.DB, sid);
  if (current && machine && machine !== current.owner) throw new Refused("not_owner", `хозяин ${current.owner}`, { owner: current.owner });
  const rows = await db.pointsOf(env.DB, sid);
  if (!rows.length) return { result: { points: 0, blocks: 0, bytes: 0 } };
  const callsign = rows.find((r) => r.id === current?.head)?.callsign ?? null;
  await db.dropPoints(env.DB, rows.map((r) => r.id));
  await db.dropSession(env.DB, sid);
  const freed = await collectOrphans(env);
  log({ kind: "note", ev: "points.delete", sid, by, points: rows.length, ...freed });
  return { result: { points: rows.length, ...freed }, line: ledgerLine("session.deleted", `${shortName(callsign, sid)} удалена из R2 · ${rows.length} точек`, { machine: current?.owner, callsign, by }) };
}

/** Уборка: правило хранения по каждой сессии, затем блоки без ссылок. */
export async function sweep(env: Env): Promise<void> {
  const now = Date.now();
  let points = 0;
  for (const s of await db.sessions(env.DB)) {
    const rows = await db.pointsOf(env.DB, s.sid);
    const out = expired(rows, s.head, now);
    await db.dropPoints(env.DB, out);
    points += out.length;
    if (out.length === rows.length) await db.dropSession(env.DB, s.sid);
  }
  const freed = await collectOrphans(env);
  await db.saveSweep(env.DB, { at: now, ...freed });
  log({ kind: "note", ev: "sweep", points, ...freed });
}

/** Запрос контракта → результат или Refused; строка журнала флота уходит отдельно. */
export async function serve(env: Env, f: Frame, machine: string | null): Promise<{ result: Record<string, unknown>; line?: LedgerAdd }> {
  switch (f.type) {
    case "points.put":
      if (!machine) throw new Refused("bad_frame", "точку кладёт только машина");
      return put(env, f, machine);
    case "points.get":
      return { result: await get(env, f, machine) };
    case "points.list":
      return { result: typeof f.sid === "string" ? await listSession(env, f.sid) : await listFleet(env) };
    case "points.delete":
      if (typeof f.sid !== "string" || !f.sid) throw new Refused("bad_frame", "нет sid");
      return remove(env, f.sid, machine, typeof f.by === "string" ? f.by : (f.from ?? ""));
    default:
      throw new Refused("unknown_request", `points не обслуживает ${f.type}`);
  }
}
