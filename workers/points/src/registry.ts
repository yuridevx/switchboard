// Реестр точек над базой D1 модуля. Хозяин сессии, линия и ветки, правило хранения,
// какие блоки уже в R2, ссылки машине на блоки, уборка раз в сутки (расписание Worker'а) и удаление сессии сразу.
// Строки журнала флота — ledger.add по своей привязке.
import { accepts, fail, machineOf, ok, type Frame } from "@switchboard/protocol";
import type { LedgerAdd } from "@switchboard/ledger";
import { CONTRACT, type ListedPoint, type Point, type PointFile, type Why } from "../contract.ts";
import { presign } from "@switchboard/release";
import type { Env } from "./env.ts";
import { gone, lineOf, untilOf } from "./keep.ts";
import { log } from "./log.ts";

const WHY = new Set<Why>(["rule", "save", "start", "raise", "yield"]);
const HASH = /^[0-9a-f]{2,128}$/;

type Row = {
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
type Session = { sid: string; owner: string; head: number };

/** Отказ словом с полями ответа (owner, ids, missing) и причиной для журнала. */
class Refusal {
  word: string;
  why: string;
  extra: Record<string, unknown>;
  constructor(word: string, why: string, extra: Record<string, unknown> = {}) {
    this.word = word;
    this.why = why;
    this.extra = extra;
  }
}

/** Решение по points.put: куда встанет точка и что станет с хозяином. */
type Plan = { base: number | null; owner: string; moveHead: boolean; event?: LedgerAdd; same?: number };

/** Кадр с to: ".points" → reply тому, кто спросил. */
export function frame(env: Env, f: Frame): Promise<Frame[]> {
  return new Registry(env).frame(f);
}

/** Уборка раз в сутки — расписанием Worker'а. */
export function sweep(env: Env): Promise<{ points: number; blocks: number; bytes: number }> {
  return new Registry(env).sweep();
}

type Arg = string | number | null;

class Registry {
  private env: Env;
  constructor(env: Env) {
    this.env = env;
  }

  async frame(f: Frame): Promise<Frame[]> {
    const from = f.from ?? "";
    const machine = from ? machineOf(from) : null;
    const answer = (r: Frame): Frame[] => (f.id ? [{ ...r, to: from }] : []);
    const refuse = (r: Refusal): Frame[] => {
      log({ kind: "refuse", ev: f.type, word: r.word, why: r.why, from, sid: typeof f.sid === "string" ? f.sid : undefined });
      return f.id ? answer({ ...fail(f.id, r.word), ...r.extra }) : [];
    };

    if (f.type === "reply") {
      log({ kind: "note", ev: "reply", from, why: "points ответов не ждёт" });
      return [];
    }
    const bad = accepts(f, CONTRACT);
    if (bad) return refuse(new Refusal(bad.word, bad.why));
    if (!f.id) return refuse(new Refusal("bad_frame", `${f.type} без id — ответить некому`));
    const id = f.id;

    try {
      switch (f.type) {
        case "points.put": {
          if (!machine) throw new Refusal("bad_frame", "точку кладёт только машина");
          const r = await this.put(f, machine);
          if (r.event) await this.journal(r.event);
          return answer(ok(id, r.result));
        }
        case "points.get": {
          const ids = f.ids;
          if (!Array.isArray(ids) || !ids.length || !ids.every((x) => Number.isInteger(x))) throw new Refusal("bad_frame", "ids — непустой список номеров");
          const rows = await this.all<Row>("SELECT * FROM points WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id", JSON.stringify(ids));
          const lost = (ids as number[]).filter((x) => !rows.some((r) => r.id === x));
          if (lost.length) throw new Refusal("no_point", `точек ${lost.join(", ")} нет`, { ids: lost });
          const s = await this.session(rows[0].sid);
          const result: Record<string, unknown> = { owner: s?.owner ?? null, points: rows.map(full) };
          // машине — ссылки GET на блоки этих точек; пульту блоки не нужны
          if (machine) result.links = await this.links("GET", [...new Set(rows.flatMap((r) => (JSON.parse(r.files) as PointFile[]).flatMap((x) => x.b)))]);
          return answer(ok(id, result));
        }
        case "points.list":
          return answer(ok(id, typeof f.sid === "string" ? await this.listSession(f.sid) : await this.listFleet()));
        case "points.delete": {
          if (typeof f.sid !== "string" || !f.sid) throw new Refusal("bad_frame", "нет sid");
          const r = await this.remove(f.sid, machine, typeof f.by === "string" ? f.by : from);
          if (r.event) await this.journal(r.event);
          return answer(ok(id, r.result));
        }
      }
    } catch (e) {
      if (e instanceof Refusal) return refuse(e);
      throw e;
    }
    return refuse(new Refusal("unknown_request", `points не обслуживает ${f.type}`));
  }

  /** Строка журнала флота по своей привязке; журнал не ответил — строка здесь. */
  private async journal(e: LedgerAdd): Promise<void> {
    try {
      await this.env.LEDGER.frame({ ...(e as unknown as Frame), from: ".points" });
    } catch (err) {
      log({ kind: "refuse", ev: "ledger.add", word: "offline", why: `${e.ev}: ${err}` });
    }
  }

  /** Ссылки на блоки f/<отпечаток>: один блок, один метод, час; подпись — общей функцией формата выпуска. */
  private async links(method: "GET" | "PUT", hashes: string[]): Promise<Record<string, string>> {
    const key = { accessKeyId: this.env.R2_KEY_ID, secretAccessKey: this.env.R2_KEY_SECRET };
    const host = `${this.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const now = new Date();
    const out: Record<string, string> = {};
    for (const h of hashes) out[h] = await presign(key, { method, host, path: `/${this.env.POINTS_BUCKET}/f/${h}`, now });
    return out;
  }

  // ---------- points.put ----------

  private async put(f: Frame, machine: string): Promise<{ result: Record<string, unknown>; event?: LedgerAdd }> {
    const sid = f.sid;
    if (typeof sid !== "string" || !sid) throw new Refusal("bad_frame", "нет sid");
    if (typeof f.why !== "string" || !WHY.has(f.why as Why)) throw new Refusal("bad_frame", `why — одно из ${[...WHY].join(", ")}`);
    const files = checkFiles(f.files);
    if (f.base !== undefined && !Number.isInteger(f.base)) throw new Refusal("bad_frame", "base — номер точки");
    if (f.why === "raise" && f.base === undefined) throw new Refusal("bad_frame", "у raise нет base");
    const stored = JSON.stringify(files);

    // хозяин до похода в R2 — чтобы не просить блоки у того, чью точку реестр не примет
    const early = await this.plan(f, sid, machine, stored);
    if (early.same !== undefined) return { result: { id: early.same, same: true } };

    // какие блоки уже в R2: в реестре или лежат в бакете (положены, а точку машина не прислала)
    const hashes = [...new Set(files.flatMap((x) => x.b))];
    const known = new Set((await this.all<{ hash: string }>("SELECT hash FROM blocks WHERE hash IN (SELECT value FROM json_each(?))", JSON.stringify(hashes))).map((r) => r.hash));
    const unknown = hashes.filter((h) => !known.has(h));
    const heads = await Promise.all(unknown.map(async (h) => ({ h, o: await this.env.BUCKET.head(`f/${h}`) })));
    const missing = heads.filter((x) => !x.o).map((x) => x.h);
    if (missing.length) {
      throw new Refusal("missing", `${missing.length} блоков нет в R2`, { missing, links: await this.links("PUT", missing) });
    }

    // решение заново после похода в R2; запись — точка, затем блоки, ссылки и хозяин одной пачкой
    const plan = await this.plan(f, sid, machine, stored);
    if (plan.same !== undefined) return { result: { id: plan.same, same: true } };
    const db = this.env.DB;
    const json = (x: unknown) => (x === undefined ? null : JSON.stringify(x));
    const num = (x: unknown) => (typeof x === "number" ? x : null);
    const str = (x: unknown) => (typeof x === "string" ? x : null);
    const row = (await db
      .prepare(
        `INSERT INTO points (sid, machine, at, why, base, callsign, dir, msgs, bytes, git, files, spec, last)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(sid, machine, Date.now(), f.why as string, plan.base, str(f.callsign), str(f.dir), num(f.msgs), num(f.bytes), json(f.git), stored, json(f.spec), json(f.last))
      .first<{ id: number }>())!;
    await db.batch([
      ...heads.map((x) => db.prepare("INSERT OR IGNORE INTO blocks (hash, size) VALUES (?, ?)").bind(x.h, x.o!.size)),
      db.prepare("INSERT OR IGNORE INTO refs (point, hash) SELECT ?, value FROM json_each(?)").bind(row.id, JSON.stringify(hashes)),
      ...(plan.moveHead ? [db.prepare("INSERT OR REPLACE INTO sessions (sid, owner, head) VALUES (?, ?, ?)").bind(sid, plan.owner, row.id)] : []),
    ]);
    log({ kind: "note", ev: "points.put", from: machine, sid, point: row.id, why: f.why, base: plan.base, blocks: hashes.length });
    return { result: { id: row.id }, event: plan.event };
  }

  /** Как реестр принимает точку: хозяин, expect, yield, «те же файлы». Отказ — Refusal. */
  private async plan(f: Frame, sid: string, machine: string, stored: string): Promise<Plan> {
    const s = await this.session(sid);
    const by = typeof f.by === "string" ? f.by : undefined;
    const callsign = typeof f.callsign === "string" ? f.callsign : undefined;
    const base = typeof f.base === "number" ? f.base : null;

    if (!s) {
      // новая сессия: хозяин — та, что прислала; base из другой сессии — копия
      if (base === null) return { base: null, owner: machine, moveHead: true };
      const src = await this.point(base);
      if (!src) throw new Refusal("no_point", `точки ${base} нет`, { ids: [base] });
      const event = ledger("session.copied", `${name(src.callsign, src.sid)} → ${callsign ?? sid.slice(0, 8)} · из точки ${base}`, machine, callsign, by);
      return { base, owner: machine, moveHead: true, event };
    }

    if (f.why === "raise") {
      // подъём: хозяин меняется одной записью — точкой с expect
      if (f.expect !== s.owner) throw new Refusal("not_owner", `хозяин ${s.owner}, expect ${String(f.expect)}`, { owner: s.owner });
      const src = base === null ? null : await this.point(base);
      if (!src) throw new Refusal("no_point", `точки ${base} нет`, { ids: [base] });
      if (src.sid !== sid) throw new Refusal("bad_frame", `точка ${base} — не этой сессии`);
      let event: LedgerAdd | undefined;
      const who = name(callsign ?? src.callsign, sid);
      if (s.owner !== machine) event = ledger("session.moved", `${who}: ${s.owner} → ${machine} · из точки ${base}`, machine, callsign, by);
      else if (base !== s.head) event = ledger("session.rolled_back", `${callsign ?? who} откатана к точке ${base}`, machine, callsign, by);
      return { base, owner: machine, moveHead: true, event };
    }

    let from: number | null;
    let plan: Plan;
    if (machine === s.owner) {
      from = s.head;
      plan = { base: from, owner: machine, moveHead: true };
    } else if (f.why === "yield") {
      // вернувшийся прежний хозяин: дописанное — ветка от его последней точки этой сессии
      from = (await this.one<{ id: number | null }>("SELECT MAX(id) AS id FROM points WHERE sid = ? AND machine = ?", sid, machine))?.id ?? null;
      plan = { base: from, owner: s.owner, moveHead: false };
    } else {
      throw new Refusal("not_owner", `хозяин ${s.owner}`, { owner: s.owner });
    }
    // пустых точек и пустых веток не бывает
    if (from !== null && (await this.point(from))?.files === stored) plan.same = from;
    return plan;
  }

  // ---------- points.delete и уборка ----------

  private async remove(sid: string, machine: string | null, by: string): Promise<{ result: Record<string, unknown>; event?: LedgerAdd }> {
    const s = await this.session(sid);
    if (s && machine && machine !== s.owner) throw new Refusal("not_owner", `хозяин ${s.owner}`, { owner: s.owner });
    const head = s ? await this.point(s.head) : null;
    const ids = (await this.all<{ id: number }>("SELECT id FROM points WHERE sid = ?", sid)).map((r) => r.id);
    if (!ids.length) return { result: { points: 0, blocks: 0, bytes: 0 } };
    await this.drop(ids);
    await this.env.DB.prepare("DELETE FROM sessions WHERE sid = ?").bind(sid).run();
    const freed = await this.collect();
    log({ kind: "note", ev: "points.delete", sid, by, points: ids.length, ...freed });
    const who = name(head?.callsign ?? null, sid);
    const event = ledger("session.deleted", `${who} удалена из R2 · ${ids.length} точек`, s?.owner, head?.callsign ?? undefined, by);
    return { result: { points: ids.length, ...freed }, event };
  }

  /** Уборка: правило хранения по каждой сессии, затем блоки без ссылок — из R2 и из реестра. */
  async sweep(): Promise<{ points: number; blocks: number; bytes: number }> {
    const db = this.env.DB;
    const now = Date.now();
    let points = 0;
    for (const s of await this.all<Session>("SELECT * FROM sessions")) {
      const all = await this.all<{ id: number; at: number; base: number | null }>("SELECT id, at, base FROM points WHERE sid = ?", s.sid);
      const out = gone(all, s.head, now);
      await this.drop(out);
      points += out.length;
      if (out.length === all.length) await db.prepare("DELETE FROM sessions WHERE sid = ?").bind(s.sid).run();
    }
    const freed = await this.collect();
    const sweep = { at: now, ...freed };
    await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sweep', ?)").bind(JSON.stringify(sweep)).run();
    log({ kind: "note", ev: "sweep", points, ...freed });
    return { points, ...freed };
  }

  /** Стереть точки; их дети переходят к основе стёртой — линия и ветки остаются связными. */
  private async drop(ids: number[]): Promise<void> {
    const db = this.env.DB;
    if (!ids.length) return;
    await db.batch(
      ids.flatMap((id) => [
        db.prepare("UPDATE points SET base = (SELECT base FROM points WHERE id = ?) WHERE base = ?").bind(id, id),
        db.prepare("DELETE FROM refs WHERE point = ?").bind(id),
        db.prepare("DELETE FROM points WHERE id = ?").bind(id),
      ]),
    );
  }

  /** Блоки без ссылок: сначала из R2, затем строка блока — оборвалось посередине, следующий раз доделает. */
  private async collect(): Promise<{ blocks: number; bytes: number }> {
    const orphans = await this.all<{ hash: string; size: number }>("SELECT hash, size FROM blocks WHERE NOT EXISTS (SELECT 1 FROM refs WHERE refs.hash = blocks.hash)");
    let bytes = 0;
    for (let i = 0; i < orphans.length; i += 1000) {
      const part = orphans.slice(i, i + 1000);
      await this.env.BUCKET.delete(part.map((b) => `f/${b.hash}`));
      await this.env.DB.prepare("DELETE FROM blocks WHERE hash IN (SELECT value FROM json_each(?))").bind(JSON.stringify(part.map((b) => b.hash))).run();
      for (const b of part) bytes += b.size;
    }
    return { blocks: orphans.length, bytes };
  }

  // ---------- points.list ----------

  private async listSession(sid: string) {
    const s = await this.session(sid);
    if (!s) return { owner: null, head: null, points: [] };
    const rows = await this.all<Row>("SELECT * FROM points WHERE sid = ? ORDER BY id DESC", sid);
    const line = lineOf(rows, s.head);
    const until = untilOf(rows, s.head);
    const points: ListedPoint[] = rows.map((r) => {
      const { files: _f, spec: _s, last: _l, sid: _sid, ...rest } = full(r);
      return { ...rest, line: line.has(r.id), until: until.get(r.id) ?? null };
    });
    return { owner: s.owner, head: s.head, points };
  }

  private async listFleet() {
    const sessions = (
      await this.all<{ sid: string; owner: string; head: number; at: number; callsign: string | null; dir: string | null; n: number; branches: number }>(
        `SELECT s.sid, s.owner, s.head, h.at, h.callsign, h.dir,
           (SELECT COUNT(*) FROM points p WHERE p.sid = s.sid) AS n,
           (SELECT COUNT(*) FROM points p WHERE p.sid = s.sid AND p.id != s.head
              AND NOT EXISTS (SELECT 1 FROM points c WHERE c.base = p.id)) AS branches
         FROM sessions s JOIN points h ON h.id = s.head ORDER BY h.at DESC`,
      )
    ).map((r) => ({
        sid: r.sid,
        ...(r.callsign !== null ? { callsign: r.callsign } : {}),
        ...(r.dir !== null ? { dir: r.dir } : {}),
        owner: r.owner,
        head: { id: r.head, at: r.at },
        points: r.n,
        branches: r.branches,
      }));
    const r2 = (await this.one<{ blocks: number; bytes: number }>("SELECT COUNT(*) AS blocks, COALESCE(SUM(size), 0) AS bytes FROM blocks"))!;
    const sw = await this.one<{ v: string }>("SELECT v FROM meta WHERE k = 'sweep'");
    return { sessions, r2: { bytes: r2.bytes, blocks: r2.blocks }, sweep: sw ? JSON.parse(sw.v) : null };
  }

  // ---------- мелочи ----------

  private session(sid: string): Promise<Session | undefined> {
    return this.one<Session>("SELECT * FROM sessions WHERE sid = ?", sid);
  }

  private point(id: number): Promise<Row | undefined> {
    return this.one<Row>("SELECT * FROM points WHERE id = ?", id);
  }

  private async one<T>(q: string, ...args: Arg[]): Promise<T | undefined> {
    return (await this.env.DB.prepare(q).bind(...args).first<T>()) ?? undefined;
  }

  private async all<T>(q: string, ...args: Arg[]): Promise<T[]> {
    return (await this.env.DB.prepare(q).bind(...args).all<T>()).results;
  }
}

/** Файлы точки по контракту: путь, размер, отпечатки hex. Хранятся в одном порядке полей — для сравнения «те же файлы». */
function checkFiles(x: unknown): PointFile[] {
  if (!Array.isArray(x) || !x.length) throw new Refusal("bad_frame", "files — непустой список");
  return x.map((f: { p?: unknown; size?: unknown; b?: unknown }) => {
    if (!f || typeof f.p !== "string" || typeof f.size !== "number" || !Array.isArray(f.b) || !f.b.every((h) => typeof h === "string" && HASH.test(h)))
      throw new Refusal("bad_frame", "файл точки — { p, size, b: [отпечатки hex] }");
    return { p: f.p, size: f.size, b: f.b as string[] };
  });
}

function full(r: Row): Point {
  const p: Point = { id: r.id, sid: r.sid, machine: r.machine, at: r.at, why: r.why, base: r.base, files: JSON.parse(r.files) };
  if (r.callsign !== null) p.callsign = r.callsign;
  if (r.dir !== null) p.dir = r.dir;
  if (r.msgs !== null) p.msgs = r.msgs;
  if (r.bytes !== null) p.bytes = r.bytes;
  if (r.git !== null) p.git = JSON.parse(r.git);
  if (r.spec !== null) p.spec = JSON.parse(r.spec);
  if (r.last !== null) p.last = JSON.parse(r.last);
  return p;
}

/** Имя сессии для журнала флота: site из site@laptop, иначе начало sid. */
function name(callsign: string | null | undefined, sid: string): string {
  return callsign ? callsign.split("@")[0] : sid.slice(0, 8);
}

function ledger(ev: string, text: string, machine?: string, callsign?: string, by?: string): LedgerAdd {
  const f: LedgerAdd = { type: "ledger.add", v: 1, to: ".ledger", ev, text };
  if (machine) f.machine = machine;
  if (callsign) f.callsign = callsign;
  if (by) f.by = by;
  return f;
}

