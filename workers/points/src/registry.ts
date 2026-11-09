// Реестр точек: кадр → запрос в D1 → ответ. Байтов точек Worker не видит: блоки машина кладёт и берёт по ссылкам хранилища флота.
import { accepts, fail, kindOf, machineOf, nameOf, ok, within, type Frame } from "@switchboard/protocol";
import { CONTRACT, type Hit, type Listed, type Point, type PointFile, type Why } from "../contract.ts";
import type { Env } from "./env.ts";
import { callsOf, linesOf, messagesOf, page } from "./history.ts";
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

type Row = {
  id: number; sid: string; machine: string; at: number; why: Why; base: number | null; callsign: string | null; dir: string | null; msgs: number | null; bytes: number | null;
  git: string | null; files: string; spec: string | null; title: string | null; model: string | null; tok_in: number | null; tok_out: number | null;
};
type SessionRow = { owner: string; head: number };

const WHY = new Set(["rule", "save", "start", "raise", "yield"]);
const HASH = /^[0-9a-f]{64}$/;
/** Каталог и поиск: сессий в ответе по умолчанию. */
const LIMIT = 50;
/** Отрывок совпадения: знаков до и после. */
const AROUND = 60;

/** Запрос к хранилищу флота по привязке: отказ — его словом, молчание или сбой — store_failed. */
async function store<T>(env: Env, f: Record<string, unknown>): Promise<T> {
  const out = await within(env.STORE.frame({ id: "s", v: 1, ...f } as Frame), "хранилище не ответило").catch((e) => {
    throw new Refusal("store_failed", `${f.type}: ${e}`);
  });
  const r = out[0] as Frame & { ok?: boolean; result?: T; error?: string };
  if (!r?.ok) throw new Refusal(r?.error ?? "store_failed", `${f.type}: хранилище отказало ${r?.error ?? "без ответа"}`);
  return r.result as T;
}
type Linked = { have?: Record<string, number>; links: Record<string, string> };
const links = async (env: Env, method: "GET" | "PUT", hashes: string[]): Promise<Linked> => (hashes.length ? store<Linked>(env, { type: "blocks.links", method, hashes }) : { have: {}, links: {} });

const hashesOf = (files: PointFile[]) => [...new Set(files.flatMap((f) => f.b))];
const present = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const parsed = (text: string | null) => (text === null ? undefined : JSON.parse(text));
const isInt = (x: unknown): x is number => Number.isInteger(x);
/** Имя сессии: из адреса; адреса нет — начало sid. */
const shortName = (who: string) => (who.includes("@") ? nameOf(who) : who.slice(0, 8));

const sessionOf = (db: D1Database, sid: string) => db.prepare("SELECT owner, head FROM sessions WHERE sid = ?").bind(sid).first<SessionRow>();
const pointOf = (db: D1Database, id: number) => db.prepare("SELECT * FROM points WHERE id = ?").bind(id).first<Row>();

/** Строка журнала флота. Журнал не ответил — строка Worker'а: точка уже лежит. */
async function ledger(env: Env, row: { ev: string; text: string; machine: string; callsign?: string; by?: unknown }) {
  const { by, ...rest } = row;
  const line = { type: "ledger.add", v: 1, to: ".ledger", from: ".points", ...rest, ...(by ? { by } : {}) };
  await within(env.LEDGER.frame(line), "журнал флота не ответил").catch((e) => log({ kind: "refuse", ev: "ledger.add", word: "offline", why: `${row.text}: ${e}` }));
}

/** Блоки без единой ссылки уходят из хранилища одним запросом и из реестра; чужих блоков уборка не знает. */
async function dropOrphans(env: Env): Promise<{ blocks: number; bytes: number }> {
  const { results } = await env.DB.prepare("SELECT hash FROM blocks WHERE hash NOT IN (SELECT hash FROM refs)").all<{ hash: string }>();
  const hashes = results.map((r) => r.hash);
  if (!hashes.length) return { blocks: 0, bytes: 0 };
  const dropped = await store<{ blocks: number; bytes: number }>(env, { type: "blocks.drop", hashes });
  await env.DB.prepare("DELETE FROM blocks WHERE hash IN (SELECT value FROM json_each(?))").bind(JSON.stringify(hashes)).run();
  return dropped;
}

function checkPut(f: Frame): { machine: string; sid: string; why: Why; files: PointFile[]; base?: number } {
  const { from, sid, why, files, base } = f;
  const good = (x: PointFile) => typeof x?.p === "string" && !!x.p && isInt(x.size) && x.size >= 0 && Array.isArray(x.b) && x.b.every((h) => typeof h === "string" && HASH.test(h));
  if (kindOf(from) !== "machine") throw new Refusal("bad_frame", "точку кладёт только машина");
  if (typeof sid !== "string" || !sid) throw new Refusal("bad_frame", "нет sid");
  if (!WHY.has(why as string)) throw new Refusal("bad_frame", `повод ${why}`);
  if (!Array.isArray(files) || !files.length || !files.every(good)) throw new Refusal("bad_frame", "файлы не по контракту");
  if (base !== undefined && (!isInt(base) || base < 1)) throw new Refusal("bad_frame", "base — не номер точки");
  if (why === "raise" && base === undefined) throw new Refusal("bad_frame", "подъём без base");
  return { machine: machineOf(from as string)!, sid, why: why as Why, files, base };
}

/** Блоки, которых нет в реестре, — одним blocks.links PUT: лежащие (have) — новые строки блоков, на остальные — ссылки PUT. */
async function blocksOf(env: Env, hashes: string[]) {
  const { results } = await env.DB.prepare("SELECT hash FROM blocks WHERE hash IN (SELECT value FROM json_each(?))").bind(JSON.stringify(hashes)).all<{ hash: string }>();
  const known = new Set(results.map((r) => r.hash));
  const { have = {}, links: put } = await links(env, "PUT", hashes.filter((h) => !known.has(h)));
  return { put, fresh: Object.entries(have).map(([hash, size]) => ({ hash, size })) };
}

function checkOwner(session: SessionRow, owner: unknown) {
  if (owner !== session.owner) throw new Refusal("not_owner", `хозяин сессии — ${session.owner}`, { owner: session.owner });
}

/** Строка журнала флота о точке: копия, перенос, откат; прочие точки событий не дают. */
function eventOf(f: Frame, machine: string, session: SessionRow | null, from: Row | null) {
  const shown = f.callsign ?? shortName(f.sid as string);
  if (!session && from) return { ev: "session.copied", text: `${shortName(from.callsign ?? from.sid)} → ${shown} · из точки ${f.base}` };
  if (!session || f.why !== "raise") return null;
  if (session.owner !== machine) return { ev: "session.moved", text: `${shortName(shown)}: ${session.owner} → ${machine} · из точки ${f.base}` };
  return f.base === session.head ? null : { ev: "session.rolled_back", text: `${shown} откатана к точке ${f.base}` };
}

const REQUESTS: Record<keyof typeof CONTRACT, (env: Env, f: Frame) => Promise<unknown>> = {
  async "points.put"(env, f) {
    const { machine, sid, why, files, base } = checkPut(f);
    const db = env.DB;
    const session = await sessionOf(db, sid);
    const from = base === undefined ? null : await pointOf(db, base);
    if (base !== undefined && !from) throw new Refusal("no_point", `точки ${base} нет`, { ids: [base] });
    if (from && from.sid !== sid && (session || f.expect !== undefined)) throw new Refusal("bad_frame", `точка ${base} — другой сессии`);
    if (session) checkOwner(session, why === "raise" ? f.expect : why === "yield" ? session.owner : machine);

    // от чего идёт точка: отдающая сессию машина — от своей последней, остальные — от головы
    const yielding = why === "yield" && !!session;
    const own = yielding ? await db.prepare("SELECT * FROM points WHERE sid = ? AND machine = ? ORDER BY id DESC LIMIT 1").bind(sid, machine).first<Row>() : session && (await pointOf(db, session.head));
    const text = JSON.stringify(files);
    if (why !== "raise" && own?.files === text) return { id: own.id, same: true };

    const { put, fresh } = await blocksOf(env, hashesOf(files));
    const missing = Object.keys(put);
    if (missing.length) throw new Refusal("missing", `нет блоков: ${missing.length}`, { missing, links: put });

    const json = (x: unknown) => (x === undefined ? null : JSON.stringify(x));
    const value = (x: unknown) => x ?? null;
    const [, inserted] = await db.batch<{ id: number }>([
      db.prepare("INSERT OR IGNORE INTO blocks (hash, size) SELECT json_extract(value, '$.hash'), json_extract(value, '$.size') FROM json_each(?)").bind(JSON.stringify(fresh)),
      db
        .prepare("INSERT INTO points (sid, machine, at, why, base, callsign, dir, msgs, bytes, git, files, spec, title, model, tok_in, tok_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .bind(sid, machine, Date.now(), why, base ?? own?.id ?? null, value(f.callsign), value(f.dir), value(f.msgs), value(f.bytes), json(f.git), text, json(f.spec), value(f.title), value(f.model), value(f.tok_in), value(f.tok_out)),
      db.prepare("INSERT INTO refs (point, hash) SELECT (SELECT MAX(id) FROM points), value FROM json_each(?)").bind(JSON.stringify(hashesOf(files))),
      ...(yielding ? [] : [db.prepare("INSERT INTO sessions (sid, owner, head) VALUES (?, ?, (SELECT MAX(id) FROM points)) ON CONFLICT (sid) DO UPDATE SET owner = excluded.owner, head = excluded.head").bind(sid, machine)]),
    ]);

    const line = eventOf(f, machine, session, from);
    if (line) await ledger(env, { ...line, machine, callsign: f.callsign, by: f.by });
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
    return { owner: session?.owner ?? null, points, ...(kindOf(from) === "machine" ? { links: (await links(env, "GET", hashesOf(points.flatMap((p) => p.files)))).links } : {}) };
  },

  async "points.list"(env, f) {
    return typeof f.sid === "string" ? sessionLine(env.DB, f.sid) : catalog(env, f);
  },

  async "points.history"(env, f) {
    const { sid, point, before, limit } = f;
    if (typeof sid !== "string" || !sid) throw new Refusal("bad_frame", "нет sid");
    if (!isInt(limit) || limit < 1 || (before !== null && typeof before !== "string") || (point !== undefined && !isInt(point))) throw new Refusal("bad_frame", "нужны limit ≥ 1, before — uuid или null, point — номер");
    const session = await sessionOf(env.DB, sid);
    const row = session && (await pointOf(env.DB, point === undefined ? session.head : (point as number)));
    if (!row || row.sid !== sid) throw new Refusal("no_point", `у сессии ${sid} нет точки ${point ?? ""}`.trim(), { ids: point === undefined ? [] : [point] });
    const file = (JSON.parse(row.files) as PointFile[]).find((x) => x.p === `${sid}.jsonl`);
    const entries = file ? await linesOf(file, (await links(env, "GET", file.b)).links, (why) => new Refusal("store_failed", why)) : [];
    const calls = callsOf(entries);
    if (!calls.length && entries.some((e) => e.type === "assistant")) log({ kind: "refuse", ev: "points.history", word: "no_calls", sid, why: "в файле разговора нет записей api-request: вызовы модели не видны" });
    const shown = page(await messagesOf(sid, entries), calls, before as string | null, limit as number);
    if (!shown) throw new Refusal("bad_frame", `записи ${String(before)} в разговоре точки нет`);
    return { point: row.id, ...shown };
  },

  async "points.delete"(env, f) {
    const { sid, from } = f;
    if (typeof sid !== "string" || !sid) throw new Refusal("bad_frame", "нет sid");
    const session = await sessionOf(env.DB, sid);
    if (!session) return { points: 0, blocks: 0, bytes: 0 };
    const machine = machineOf(from as string);
    if (kindOf(from) === "machine") checkOwner(session, machine);
    const head = await pointOf(env.DB, session.head);
    const [, gone] = await env.DB.batch([
      env.DB.prepare("DELETE FROM refs WHERE point IN (SELECT id FROM points WHERE sid = ?)").bind(sid),
      env.DB.prepare("DELETE FROM points WHERE sid = ?").bind(sid),
      env.DB.prepare("DELETE FROM sessions WHERE sid = ?").bind(sid),
    ]);
    const points = gone.meta.changes;
    const dropped = await dropOrphans(env);
    const callsign = head?.callsign ?? sid;
    const by = f.by ?? from;
    log({ kind: "note", ev: "points.delete", sid, by, points, ...dropped });
    await ledger(env, { ev: "session.deleted", text: `${shortName(callsign)} удалена из архива · ${points} точек`, machine: session.owner, callsign, by });
    return { points, ...dropped };
  },
};

function toPoint(r: Row): Point {
  const { git, files, spec, ...rest } = r;
  return { ...present(rest), base: r.base, files: JSON.parse(files), ...present({ git: parsed(git), spec: parsed(spec) }) } as Point;
}

async function sessionLine(db: D1Database, sid: string) {
  const session = await sessionOf(db, sid);
  if (!session) return { owner: null, head: null, points: [] };
  const { results } = await db.prepare("SELECT id, machine, at, why, base, callsign, dir, msgs, bytes, git, title, model, tok_in, tok_out FROM points WHERE sid = ? ORDER BY id DESC").bind(sid).all<Node & Pick<Row, "git">>();
  const line = lineOf(results, session.head);
  const until = expiries(results, session.head);
  const points = results.map(({ git, ...r }) => ({ ...present(r), base: r.base, ...present({ git: parsed(git) }), line: line.has(r.id), until: until.get(r.id) }));
  return { ...session, points };
}

type Line = { sid: string; owner: string; head: number; at: number; callsign: string | null; dir: string | null; title: string | null; model: string | null; tok_in: number | null; tok_out: number | null; files: string; points: number; branches: number };

/** Текст записи разговора для отрывка: текст сообщения, если q в нём; иначе строка как есть. */
function textOf(record: Record<string, any>, line: string, q: string): string {
  const c = record.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: Record<string, any>) => (typeof x.text === "string" ? x.text : typeof x.content === "string" ? x.content : "")).join("\n") : "";
  return text.toLowerCase().includes(q) ? text : line;
}

/** Совпадение — запись разговора с uuid; строка без uuid (служебная запись) совпадением не считается. */
function hitOf(line: string, q: string, point: number): Hit | null {
  let record: Record<string, any>;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record.uuid !== "string") return null;
  const text = textOf(record, line, q);
  const at = Math.max(0, text.toLowerCase().indexOf(q));
  const from = Math.max(0, at - AROUND);
  return { uuid: record.uuid, point, at: String(record.timestamp ?? ""), text: `${from ? "…" : ""}${text.slice(from, at + q.length + 2 * AROUND)}` };
}

/** Каталог из реестра; с q — сессии с совпадением в файле разговора последней точки: поиск — у хранилища по отпечаткам блоков. */
async function catalog(env: Env, f: Frame) {
  const db = env.DB;
  const since = typeof f.since === "string" ? Date.parse(f.since) || 0 : 0;
  const limit = Number.isInteger(f.limit) && (f.limit as number) > 0 ? (f.limit as number) : LIMIT;
  const q = typeof f.q === "string" ? f.q.trim().toLowerCase() : "";
  const order = f.order === "tokens" ? "COALESCE(h.tok_in, 0) + COALESCE(h.tok_out, 0) DESC" : "h.at DESC";
  const [sessions, totals, sweep] = await Promise.all([
    db
      .prepare(`SELECT s.sid, s.owner, s.head, h.at, h.callsign, h.dir, h.title, h.model, h.tok_in, h.tok_out, h.files, COUNT(p.id) AS points,
        SUM(p.id != s.head AND NOT EXISTS (SELECT 1 FROM points c WHERE c.base = p.id)) AS branches
      FROM sessions s JOIN points h ON h.id = s.head JOIN points p ON p.sid = s.sid WHERE h.at >= ? GROUP BY s.sid ORDER BY ${order}, s.sid`)
      .bind(since)
      .all<Line>(),
    db.prepare("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS blocks FROM blocks").first<{ bytes: number; blocks: number }>(),
    db.prepare("SELECT v FROM meta WHERE k = 'sweep'").first<{ v: string }>(),
  ]);
  const listed = (x: Line, hits?: Hit[]): Listed => {
    const { head, at, files: _files, ...rest } = x;
    return { ...present(rest), head: { id: head, at }, ...(hits ? { hits } : {}) } as Listed;
  };
  const tail = { store: totals!, sweep: sweep && JSON.parse(sweep.v) };
  if (!q) {
    // умеет ли хранилище искать — его же ответом на пустой поиск
    const search = await store(env, { type: "blocks.search", q: "", hashes: [], limit: 1 }).then(
      () => true,
      (e) => (e instanceof Refusal && e.word === "no_search" ? false : Promise.reject(e)),
    );
    return { search, sessions: sessions.results.slice(0, limit).map((x) => listed(x)), ...tail };
  }
  // отпечаток блока → сессии, в чьём файле разговора последней точки он есть: у копий начало разговора общее
  const owners = new Map<string, Line[]>();
  for (const x of sessions.results) for (const file of JSON.parse(x.files) as PointFile[]) if (file.p === `${x.sid}.jsonl`) for (const h of file.b) owners.set(h, [...(owners.get(h) ?? []), x]);
  const found = await store<Array<{ hash: string; line: string }>>(env, { type: "blocks.search", q, hashes: [...owners.keys()], limit: owners.size });
  const hits = new Map<string, Hit[]>();
  for (const { hash, line } of found) {
    for (const x of owners.get(hash) ?? []) {
      const hit = hitOf(line, q, x.head);
      if (hit) hits.set(x.sid, [...(hits.get(x.sid) ?? []), hit]);
    }
  }
  return { search: true, sessions: sessions.results.filter((x) => hits.has(x.sid)).slice(0, limit).map((x) => listed(x, hits.get(x.sid))), ...tail };
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
      if (base !== n.base) moves.push(db.prepare("UPDATE points SET base = ? WHERE id = ?").bind(base, n.id));
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
