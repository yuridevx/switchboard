// Архив сессий: точки. Блоки файлов — в R2 под именем хэша содержимого, у каждой машины свои; реестр и текст сообщений с поиском по словам —
// в записях на машину. Поиск опрашивает только машины, до которых человек достаёт.
import { type ArchPoint, type ArchSession, canReach, errFields, machineOf, type ModelCall, Refusal, type SdkEvent, personOf } from "@sb/protocol";
import type { Ctx, Env, Module } from "../env.ts";
import { link, readBlocks } from "../r2.ts";
import { type Op, records } from "../records.ts";
import { fleetPref } from "./prefs.ts";

const NAME = "archive";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, callsign TEXT, title TEXT, model TEXT, cwd TEXT, project TEXT, last INTEGER, points INTEGER, bytes INTEGER, tokens INTEGER)",
  "CREATE TABLE IF NOT EXISTS points (sid TEXT, point TEXT, at INTEGER, label TEXT, turns INTEGER, bytes INTEGER, git TEXT, files TEXT NOT NULL, PRIMARY KEY (sid, point))",
  "CREATE TABLE IF NOT EXISTS msg (id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, sid TEXT, role TEXT)",
  "CREATE INDEX IF NOT EXISTS msg_sid ON msg (sid)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS msgs USING fts5 (body, tokenize = 'unicode61')",
  // какая точка держит какой блок: блок без ссылок убирается из хранилища
  "CREATE TABLE IF NOT EXISTS refs (hash TEXT, sid TEXT, point TEXT, PRIMARY KEY (hash, sid, point))",
  "CREATE INDEX IF NOT EXISTS refs_point ON refs (sid, point)",
  // документ сессии на последней точке: с ним её поднимают
  "CREATE TABLE IF NOT EXISTS specs (sid TEXT PRIMARY KEY, spec TEXT NOT NULL)",
  // от какой точки продолжена точка: ветки линии
  "CREATE TABLE IF NOT EXISTS bases (sid TEXT, point TEXT, base TEXT NOT NULL, PRIMARY KEY (sid, point))",
  // когда запись разговора попала в архив: по этому времени находится точка, с которой она есть
  "CREATE TABLE IF NOT EXISTS msgat (uuid TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  // последняя уборка линии точек: когда и сколько убрано
  "CREATE TABLE IF NOT EXISTS sweeps (one INTEGER PRIMARY KEY CHECK (one = 1), at INTEGER, points INTEGER, blocks INTEGER)",
];
const db = (env: Env, fleet: string, machine: string) => records(env, fleet, NAME, SCHEMA, machine);

const HASH = /^[0-9a-f]{64}$/;
const TEXT_MAX = 20_000;
const HEADS_AT_ONCE = 50;
/** Столько ключей R2 удаляется одним вызовом. */
const DELETE_AT_ONCE = 500;

/** Блоки у каждой машины свои: уборка блока не зависит от архивов соседних машин. */
/** Блок лежит сжатым: это видно по имени, а не угадывается по содержимому. */
export const blockKey = (fleet: string, machine: string, hash: string) => `blocks/${fleet}/${machine}/${hash}.gz`;

type FileIn = { path: string; blocks: string[]; size: number };
type SessionRow = { sid: string; callsign: string; title: string | null; model: string | null; cwd: string | null; project: string | null; last: number; points: number; bytes: number | null; tokens: number | null };
type PointRow = { sid: string; point: string; at: number; label: string | null; turns: number | null; bytes: number | null; git: string | null; files: string };

const session = (s: SessionRow, machine: string, extra: { hit?: string; live?: boolean; owner?: string } = {}): ArchSession => ({
  sid: s.sid, machine, callsign: s.callsign, points: s.points, last: s.last,
  ...(s.title ? { title: s.title } : {}), ...(s.model ? { model: s.model } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), ...(s.project ? { project: s.project } : {}),
  ...(s.bytes != null ? { bytes: s.bytes } : {}), ...(s.tokens != null ? { tokens: s.tokens } : {}),
  ...(extra.hit ? { hit: extra.hit } : {}), ...(extra.live ? { live: true } : {}), ...(extra.owner ? { owner: extra.owner } : {}),
});
const point = (p: Pick<PointRow, "point" | "at" | "label" | "turns" | "bytes" | "git">, until?: number | null): ArchPoint => ({
  point: p.point, at: p.at,
  ...(p.label ? { label: p.label } : {}), ...(p.turns != null ? { turns: p.turns } : {}), ...(p.bytes != null ? { bytes: p.bytes } : {}), ...(p.git ? { git: p.git } : {}),
  ...(until != null ? { until } : {}),
});

/* ===== Правило хранения =====
   Последняя точка сессии — без срока. Линия редеет сама: последняя точка недели живёт год от своего дня, последняя точка дня — 30 дней, прочие — два дня. */

const DAY = 86_400_000;
const dayOf = (t: number) => t - (t % DAY);
/** Номер недели с понедельника: 1 января 1970 — четверг. */
const weekOf = (t: number) => Math.floor((Math.floor(t / DAY) + 3) / 7);

/** Срок каждой точки сессии: null — без срока. Чистая функция над точками одной сессии. */
export function expiries(points: { point: string; at: number }[]): Map<string, number | null> {
  const sorted = [...points].sort((a, b) => a.at - b.at || a.point.localeCompare(b.point));
  const lastBy = (group: (at: number) => number) => {
    const last = new Map<number, string>();
    for (const p of sorted) last.set(group(p.at), p.point);
    return new Set(last.values());
  };
  const days = lastBy(dayOf), weeks = lastBy(weekOf);
  const until = new Map<string, number | null>();
  for (const p of sorted) until.set(p.point, dayOf(p.at) + (weeks.has(p.point) ? 365 * DAY : days.has(p.point) ? 30 * DAY : 2 * DAY));
  const head = sorted.at(-1);
  if (head) until.set(head.point, null);
  return until;
}

/** Убрать точки сессии и блоки, на которые больше никто не ссылается. Блоки стираются после записей: сбой хранилища оставит лишний блок, а не битую точку. */
async function drop(env: Env, fleet: string, machine: string, sid: string, names: string[] | "all"): Promise<number> {
  const d = db(env, fleet, machine);
  const orphans = new Set<string>();
  if (names === "all") {
    const got = await d.batch([
      ["SELECT DISTINCT hash FROM refs WHERE sid = ?1 AND NOT EXISTS (SELECT 1 FROM refs o WHERE o.hash = refs.hash AND o.sid != ?1)", sid],
      ["DELETE FROM refs WHERE sid = ?", sid],
      ["DELETE FROM msgs WHERE rowid IN (SELECT id FROM msg WHERE sid = ?)", sid],
      ["DELETE FROM msgat WHERE uuid IN (SELECT uuid FROM msg WHERE sid = ?)", sid],
      ["DELETE FROM msg WHERE sid = ?", sid],
      ["DELETE FROM points WHERE sid = ?", sid],
      ["DELETE FROM sessions WHERE sid = ?", sid],
    ]);
    for (const r of got[0]!) orphans.add(r.hash as string);
  } else {
    // по одной точке: блок, общий для двух убираемых точек, станет сиротой на второй
    for (const name of names) {
      const got = await d.batch([
        ["SELECT hash FROM refs WHERE sid = ?1 AND point = ?2 AND NOT EXISTS (SELECT 1 FROM refs o WHERE o.hash = refs.hash AND NOT (o.sid = ?1 AND o.point = ?2))", sid, name],
        ["DELETE FROM refs WHERE sid = ? AND point = ?", sid, name],
        ["DELETE FROM points WHERE sid = ? AND point = ?", sid, name],
        ["UPDATE sessions SET points = (SELECT count(*) FROM points WHERE sid = ?1) WHERE sid = ?1", sid],
      ]);
      for (const r of got[0]!) orphans.add(r.hash as string);
    }
  }
  const keys = [...orphans].map((h) => blockKey(fleet, machine, h));
  for (let i = 0; i < keys.length; i += DELETE_AT_ONCE) await env.FILES.delete(keys.slice(i, i + DELETE_AT_ONCE));
  return keys.length;
}

/** Каких блоков ещё нет в хранилище. */
async function missing(env: Env, fleet: string, machine: string, hashes: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < hashes.length; i += HEADS_AT_ONCE) {
    const part = hashes.slice(i, i + HEADS_AT_ONCE);
    const heads = await Promise.all(part.map((h) => env.FILES.head(blockKey(fleet, machine, h))));
    part.forEach((h, n) => heads[n] || out.push(h));
  }
  return out;
}

/** Машины, по которым идёт запрос: названная (если до неё достаёт) или все свои. */
function machinesOf(ctx: Ctx, machine?: string): string[] {
  if (!machine) return ctx.who.machines;
  if (!canReach(ctx.who, machine)) throw new Refusal("forbidden", `до машины ${machine} вы не достаёте`);
  return [machine];
}

/** Где лежит сессия архива: среди машин, до которых человек достаёт. */
async function find(ctx: Ctx, sid: string): Promise<{ machine: string; row: SessionRow }> {
  const got = await Promise.all(ctx.who.machines.map(async (m) => ({ machine: m, row: await db(ctx.env, ctx.fleet, m).first<SessionRow>("SELECT * FROM sessions WHERE sid = ?", sid) })));
  const hit = got.find((g) => g.row);
  if (!hit) throw new Refusal("not_found", `сессии ${sid} в архиве нет`);
  return { machine: hit.machine, row: hit.row! };
}

/** Точка сессии: названная или последняя. */
async function pointOf(env: Env, fleet: string, machine: string, sid: string, name?: string): Promise<PointRow> {
  const d = db(env, fleet, machine);
  const p = name ? await d.first<PointRow>("SELECT * FROM points WHERE sid = ? AND point = ?", sid, name) : await d.first<PointRow>("SELECT * FROM points WHERE sid = ? ORDER BY at DESC LIMIT 1", sid);
  if (!p) throw new Refusal("not_found", name ? `точки ${name} у сессии ${sid} нет` : `у сессии ${sid} нет точек`);
  return p;
}

/** Файл разговора точки: файл сессии claude — строки JSON. */
const transcript = (files: FileIn[], sid: string) => files.find((f) => f.path.endsWith(`${sid}.jsonl`)) ?? files.find((f) => f.path.endsWith(".jsonl"));

function parseLines(text: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object" && typeof v.type === "string") lines.push(v);
    } catch {
      // оборванная строка — не событие
    }
  }
  return lines;
}

/** Строки разговора точки целиком: для аналитики и вызовов модели. Файла разговора нет — пусто. */
export async function conversation(env: Env, fleet: string, machine: string, sid: string, name?: string): Promise<{ point: PointRow; session: SessionRow | null; lines: Record<string, unknown>[] }> {
  const p = await pointOf(env, fleet, machine, sid, name);
  const s = await db(env, fleet, machine).first<SessionRow>("SELECT * FROM sessions WHERE sid = ?", sid);
  const file = transcript(JSON.parse(p.files) as FileIn[], sid);
  if (!file) return { point: p, session: s, lines: [] };
  const text = new TextDecoder().decode(await readBlocks(env, file.blocks.map((h) => blockKey(fleet, machine, h))));
  return { point: p, session: s, lines: parseLines(text) };
}

/** Страница разговора с конца: читаются только последние блоки файла — столько, сколько нужно для страницы. */
async function page(env: Env, fleet: string, machine: string, file: FileIn, before: string | undefined, limit: number): Promise<{ events: Record<string, unknown>[]; more: boolean; read: number }> {
  let upto: Record<string, unknown>[] = [];
  let from = file.blocks.length;
  while (from > 0) {
    from--;
    const text = new TextDecoder().decode(await readBlocks(env, file.blocks.slice(from).map((h) => blockKey(fleet, machine, h))));
    // блок начинается посреди строки: её начало — в предыдущем блоке
    const lines = parseLines(from > 0 ? text.slice(text.indexOf("\n") + 1) : text);
    const cut = before ? lines.findIndex((l) => l.uuid === before) : -1;
    upto = cut >= 0 ? lines.slice(0, cut) : lines;
    // страница набрана, когда нашлась граница (или её не просили) и до неё хватает строк
    if ((!before || cut >= 0) && upto.length > limit) break;
  }
  return { events: upto.slice(-limit), more: upto.length > limit || from > 0, read: file.blocks.length - from };
}

/** Точки машины с этого момента: для доливки аналитики. */
export const pointsSince = (env: Env, fleet: string, machine: string, from: number) => db(env, fleet, machine).all<{ sid: string; point: string }>("SELECT sid, point FROM points WHERE at >= ? ORDER BY at", from);

/* ===== Вызовы модели ===== */

type Call = { call: string; at: number; model: string; input: number; output: number; cache_read: number; cache_write: number };

/** Вызовы модели из строк разговора: у строк одного ответа общий номер — берётся один раз. */
export function callsOf(lines: Record<string, unknown>[]): Call[] {
  const by = new Map<string, Call>();
  for (const l of lines) {
    const m = l.message as { id?: string; model?: string; usage?: Record<string, number> } | undefined;
    if (l.type !== "assistant" || !m?.usage) continue;
    const call = m.id ?? (l.requestId as string | undefined) ?? (l.uuid as string | undefined);
    if (!call) continue;
    const u = m.usage;
    by.set(call, {
      call, at: Date.parse(String(l.timestamp ?? "")) || 0, model: m.model ?? "",
      input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0,
    });
  }
  return [...by.values()];
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b: { type?: string; text?: string; name?: string; input?: unknown; content?: unknown }) => (b?.type === "text" ? (b.text ?? "") : b?.type === "tool_use" ? `[вызов ${b.name}] ${JSON.stringify(b.input ?? {})}` : b?.type === "tool_result" ? `[итог] ${textOf(b.content)}` : "")).filter(Boolean).join("\n")
      : "";

/** Текст вызова модели: системный промпт (запись формы запроса, если claude её сохранил) и сообщения разговора до ответа — страница с конца. */
export function callText(lines: Record<string, unknown>[], call: string, before: number | undefined, limit: number): { model: string; system: string; messages: { n: number; role: string; text: string }[]; more: boolean } | null {
  const idOf = (l: Record<string, unknown>) => (l.message as { id?: string } | undefined)?.id ?? (l.requestId as string | undefined) ?? (l.uuid as string | undefined);
  const at = lines.findIndex((l) => l.type === "assistant" && idOf(l) === call);
  if (at < 0) return null;
  const answer = lines[at]!;
  // форма запроса: api-request по ссылке ответа → api-request-shape по её отпечатку
  const req = lines.find((l) => l.type === "api-request" && l.id === answer.requestRef) as { shapeHash?: string } | undefined;
  const shape = req ? (lines.find((l) => l.type === "api-request-shape" && l.shapeHash === req.shapeHash) as { shape?: { system?: unknown } } | undefined) : undefined;
  const s = shape?.shape?.system;
  const system = typeof s === "string" ? s : Array.isArray(s) ? s.map((x: { text?: string }) => x.text ?? "").join("\n\n") : "";
  const said = lines.slice(0, at).flatMap((l) => {
    if (l.type !== "user" && l.type !== "assistant") return [];
    const text = textOf((l.message as { content?: unknown } | undefined)?.content);
    return text ? [{ role: l.type as string, text }] : [];
  }).map((m, n) => ({ n, ...m }));
  const upto = before === undefined ? said : said.filter((m) => m.n < before);
  return { model: (answer.message as { model?: string } | undefined)?.model ?? "", system, messages: upto.slice(-limit), more: upto.length > limit };
}

/** Таблица цен флота — общая настройка `prices`: модель (или начало её имени) → доллары за миллион токенов. */
export type Prices = Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
export const prices = (env: Env, fleet: string) => fleetPref<Prices>(env, fleet, "prices");

/** Стоимость вызовов модели по таблице цен: берётся самое длинное имя, с которого начинается модель. Цены нет — undefined. */
export function costOf(table: Prices | null, model: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | undefined {
  if (!table) return undefined;
  const key = Object.keys(table).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (key === undefined) return undefined;
  const p = table[key]!;
  return (t.input * (p.input ?? 0) + t.output * (p.output ?? 0) + t.cacheRead * (p.cacheRead ?? 0) + t.cacheWrite * (p.cacheWrite ?? 0)) / 1_000_000;
}

/** Сколько знаков текста показать по обе стороны от найденного слова. */
const AROUND = 60;
/** Строка вокруг первого найденного слова запроса: до AROUND знаков с каждой стороны, обрыв помечен многоточием. */
export function around(body: string, q: string): string {
  const low = body.toLowerCase();
  const found = q.split(/s+/).filter(Boolean).map((w) => ({ at: low.indexOf(w.toLowerCase()), len: w.length })).filter((f) => f.at >= 0).sort((a, b) => a.at - b.at)[0];
  if (!found) return body.slice(0, AROUND * 2);
  const from = Math.max(0, found.at - AROUND), to = Math.min(body.length, found.at + found.len + AROUND);
  return (from > 0 ? "…" : "") + body.slice(from, to).replace(/s+/g, " ") + (to < body.length ? "…" : "");
}

/** Слова запроса — в запрос полнотекстового поиска: каждое слово целиком, все сразу. */
const match = (q: string) => q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");

/** Сессии, которые сейчас есть на машинах и не остановлены, и владельцы машин — пометки каталога. */
async function marks(ctx: Ctx): Promise<{ live: Set<string>; owner: Map<string, string> }> {
  const [sessions, machines] = await Promise.all([ctx.platform.sessions(ctx.fleet), ctx.platform.machines(ctx.fleet)]);
  return {
    live: new Set(sessions.filter((s) => s.state !== "stopped" && s.state !== "failed").map((s) => s.callsign)),
    owner: new Map(machines.map((m) => [m.name, m.owner])),
  };
}

export const archive: Module = {
  name: NAME,
  handlers: {
    async "points.put"(i: {
      sid: string; callsign: string; point: string; base?: string; spec?: unknown; label?: string; title?: string; model?: string; cwd?: string; project?: string; git?: string; turns?: number; tokens?: number;
      files: FileIn[]; text?: { uuid: string; role: string; text: string }[]; commit?: boolean;
    }, ctx) {
      const machine = machineOf(ctx.who.addr)!;
      const hashes = [...new Set(i.files.flatMap((f) => f.blocks))];
      const bad = hashes.find((h) => !HASH.test(h));
      if (bad) throw new Refusal("bad_input", `блок ${bad} — не хэш SHA-256`);
      const need = await missing(ctx.env, ctx.fleet, machine, hashes);
      if (need.length) {
        if (i.commit) throw new Refusal("blocks_missing", `не загружено блоков: ${need.length}`);
        const upload: Record<string, string> = {};
        for (const h of need) upload[h] = await link(ctx.env, "PUT", blockKey(ctx.fleet, machine, h));
        return { upload, done: false };
      }
      const now = Date.now();
      const bytes = i.files.reduce((n, f) => n + f.size, 0);
      const ops: Op[] = [
        [
          `INSERT INTO sessions (sid, callsign, title, model, cwd, project, last, points, bytes, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT (sid) DO UPDATE SET callsign = excluded.callsign, title = coalesce(excluded.title, title), model = coalesce(excluded.model, model),
             cwd = coalesce(excluded.cwd, cwd), project = coalesce(excluded.project, project), last = excluded.last, bytes = excluded.bytes, tokens = coalesce(excluded.tokens, tokens)`,
          i.sid, i.callsign, i.title ?? null, i.model ?? null, i.cwd ?? null, i.project ?? null, now, bytes, i.tokens ?? null,
        ],
        ["INSERT OR REPLACE INTO points (sid, point, at, label, turns, bytes, git, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", i.sid, i.point, now, i.label ?? null, i.turns ?? null, bytes, i.git ?? null, JSON.stringify(i.files)],
        ...(i.spec ? [["INSERT OR REPLACE INTO specs (sid, spec) VALUES (?, ?)", i.sid, JSON.stringify(i.spec)] as Op] : []),
        ...(i.base ? [["INSERT OR REPLACE INTO bases (sid, point, base) VALUES (?, ?, ?)", i.sid, i.point, i.base] as Op] : []),
        ["DELETE FROM refs WHERE sid = ? AND point = ?", i.sid, i.point],
        ["UPDATE sessions SET points = (SELECT count(*) FROM points WHERE sid = ?1) WHERE sid = ?1", i.sid],
      ];
      for (const h of hashes) ops.push(["INSERT OR IGNORE INTO refs (hash, sid, point) VALUES (?, ?, ?)", h, i.sid, i.point]);
      for (const m of i.text ?? []) {
        ops.push(["INSERT OR IGNORE INTO msg (uuid, sid, role) VALUES (?, ?, ?)", m.uuid, i.sid, m.role]);
        ops.push(["INSERT OR IGNORE INTO msgat (uuid, at) VALUES (?, ?)", m.uuid, now]);
        ops.push(["INSERT INTO msgs (rowid, body) SELECT id, ?1 FROM msg WHERE uuid = ?2 AND NOT EXISTS (SELECT 1 FROM msgs WHERE msgs.rowid = msg.id)", m.text.slice(0, TEXT_MAX), m.uuid]);
      }
      ops.push(["SELECT point, at FROM points WHERE sid = ?", i.sid]);
      const got = await db(ctx.env, ctx.fleet, machine).batch(ops);
      // правило хранения: с каждой новой точкой линия сессии редеет; блоки без ссылок убираются
      const all = got.at(-1) as unknown as { point: string; at: number }[];
      const until = expiries(all);
      const expired = all.filter((p) => until.get(p.point) != null && until.get(p.point)! <= now).map((p) => p.point);
      if (expired.length)
        ctx.after(drop(ctx.env, ctx.fleet, machine, i.sid, expired).then(async (blocks) => {
          await db(ctx.env, ctx.fleet, machine).run("INSERT OR REPLACE INTO sweeps (one, at, points, blocks) VALUES (1, ?, ?, ?)", Date.now(), expired.length, blocks);
          ctx.log.info("точки с вышедшим сроком убраны", { machine, sid: i.sid, points: expired.length, blocks });
        }));
      // аналитика в стороне: записка не ушла — точка всё равно сохранена
      try {
        await ctx.env.ANALYTICS.send({ fleet: ctx.fleet, machine, sid: i.sid, point: i.point });
      } catch (e) {
        ctx.log.warn("записка аналитике не ушла", { machine, ...errFields(e) });
      }
      return { upload: {}, done: true };
    },

    async "points.list"(i: { q?: string; machine?: string; sid?: string; before?: number; since?: number; order?: "last" | "tokens"; limit?: number }, ctx) {
      const limit = Math.min(i.limit ?? 50, 200);
      const before = i.before ?? Number.MAX_SAFE_INTEGER, since = i.since ?? 0;
      const mark = await marks(ctx);
      const seen = (s: SessionRow, m: string, hit?: string) => session(s, m, { hit, live: mark.live.has(s.callsign), owner: mark.owner.get(m) });
      if (i.sid) {
        const { machine, row } = i.machine ? await (async () => {
          const [m] = machinesOf(ctx, i.machine);
          const r = await db(ctx.env, ctx.fleet, m!).first<SessionRow>("SELECT * FROM sessions WHERE sid = ?", i.sid!);
          if (!r) throw new Refusal("not_found", `сессии ${i.sid} в архиве нет`);
          return { machine: m!, row: r };
        })() : await find(ctx, i.sid);
        const pts = await db(ctx.env, ctx.fleet, machine).all<PointRow>("SELECT * FROM points WHERE sid = ? ORDER BY at DESC", i.sid);
        const until = expiries(pts);
        const bases = new Map((await db(ctx.env, ctx.fleet, machine).all<{ point: string; base: string }>("SELECT point, base FROM bases WHERE sid = ?", i.sid)).map((b) => [b.point, b.base]));
        return { sessions: [seen(row, machine)], points: pts.map((p) => ({ ...point(p, until.get(p.point)), ...(bases.has(p.point) ? { base: bases.get(p.point)! } : {}) })), more: false };
      }
      const words = i.q ? match(i.q) : "";
      const order = i.order === "tokens" ? "coalesce(tokens, 0) DESC, last DESC" : "last DESC";
      const per = await Promise.all(
        machinesOf(ctx, i.machine).map(async (m) => {
          const d = db(ctx.env, ctx.fleet, m);
          if (!words) return (await d.all<SessionRow>(`SELECT * FROM sessions WHERE last < ? AND last >= ? ORDER BY ${order} LIMIT ?`, before, since, limit + 1)).map((s) => seen(s, m));
          // сессии со словом — подзапросом: число найденных сессий не упирается в предел параметров запроса
          const rows = await d.all<SessionRow & { mid: number }>(
            `SELECT s.*, (SELECT msg.id FROM msgs JOIN msg ON msg.id = msgs.rowid WHERE msgs MATCH ?1 AND msg.sid = s.sid ORDER BY msg.id LIMIT 1) AS mid
             FROM sessions s WHERE s.last < ?2 AND s.last >= ?3 AND s.sid IN (SELECT msg.sid FROM msgs JOIN msg ON msg.id = msgs.rowid WHERE msgs MATCH ?1)
             ORDER BY ${order.replaceAll("tokens", "s.tokens").replaceAll("last", "s.last")} LIMIT ?4`,
            words, before, since, limit + 1,
          );
          // найденная запись: её номер, строка вокруг слова и точка, с которой запись есть в архиве
          const hits = new Map(
            (await d.all<{ id: number; uuid: string; sid: string; body: string; point: string | null }>(
              `SELECT msg.id, msg.uuid, msg.sid, msgs.body,
                 (SELECT p.point FROM points p WHERE p.sid = msg.sid AND p.at >= coalesce((SELECT at FROM msgat WHERE uuid = msg.uuid), 0) ORDER BY p.at LIMIT 1) AS point
               FROM msg JOIN msgs ON msgs.rowid = msg.id WHERE msg.id IN (SELECT value FROM json_each(?))`,
              JSON.stringify(rows.map((r) => r.mid)),
            )).map((h) => [h.id, h]),
          );
          return rows.map(({ mid, ...s }) => {
            const h = hits.get(mid);
            return { ...seen(s as SessionRow, m, h ? around(h.body, i.q!) : undefined), ...(h ? { hitUuid: h.uuid, ...(h.point ? { hitPoint: h.point } : {}) } : {}) };
          });
        }),
      );
      const all = per.flat().sort(i.order === "tokens" ? (a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || b.last - a.last : (a, b) => b.last - a.last);
      return { sessions: all.slice(0, limit), more: all.length > limit };
    },

    /** Обзор архива: по объекту записей каждой машины, до которой человек достаёт. */
    async "points.stats"(i: { machine?: string }, ctx) {
      const machines = await Promise.all(
        machinesOf(ctx, i.machine).map(async (machine) => {
          const got = await db(ctx.env, ctx.fleet, machine).batch([
            ["SELECT count(*) AS sessions, coalesce(sum(bytes), 0) AS bytes FROM sessions"],
            ["SELECT count(*) AS points FROM points"],
            ["SELECT count(DISTINCT hash) AS blocks FROM refs"],
            ["SELECT at, points, blocks FROM sweeps WHERE one = 1"],
          ]);
          const sweep = got[3]![0] as { at: number; points: number; blocks: number } | undefined;
          return { machine, sessions: got[0]![0]!.sessions as number, bytes: got[0]![0]!.bytes as number, points: got[1]![0]!.points as number, blocks: got[2]![0]!.blocks as number, ...(sweep ? { sweep } : {}) };
        }),
      );
      const sum = (k: "sessions" | "points" | "blocks" | "bytes") => machines.reduce((n, m) => n + m[k], 0);
      const last = machines.flatMap((m) => (m.sweep ? [m.sweep] : [])).sort((a, b) => b.at - a.at)[0];
      return { sessions: sum("sessions"), points: sum("points"), blocks: sum("blocks"), bytes: sum("bytes"), ...(last ? { sweep: last } : {}), machines: machines.filter((m) => m.sessions || m.points) };
    },

    async "points.get"(i: { sid: string; point?: string; expect?: string; move?: boolean; by?: string }, ctx) {
      const { machine, row } = await find(ctx, i.sid);
      if (i.expect !== undefined) {
        const head = await pointOf(ctx.env, ctx.fleet, machine, i.sid);
        if (head.point !== i.expect) throw new Refusal("changed", `в архиве уже точка ${head.point}, а не ${i.expect}`);
      }
      if (i.move) {
        // перенос забирает сессию у её машины: это решает владелец той машины или админ. Машина называет человека, который начал перенос
        const person = personOf(i.by ?? "") ?? ctx.who.person;
        const [machines, admins] = await Promise.all([ctx.platform.machines(ctx.fleet), ctx.platform.admins(ctx.fleet)]);
        const owner = machines.find((m) => m.name === machine)?.owner;
        if (person !== owner && !admins.includes(person)) throw new Refusal("not_owner", `хозяин сессии — ${owner ?? "владелец машины " + machine}`);
      }
      const p = await pointOf(ctx.env, ctx.fleet, machine, i.sid, i.point);
      const files = [];
      for (const f of JSON.parse(p.files) as FileIn[]) {
        const blocks = [];
        for (const hash of f.blocks) blocks.push({ hash, url: await link(ctx.env, "GET", blockKey(ctx.fleet, machine, hash)) });
        files.push({ path: f.path, size: f.size, blocks });
      }
      const spec = await db(ctx.env, ctx.fleet, machine).first<{ spec: string }>("SELECT spec FROM specs WHERE sid = ?", i.sid);
      const base = await db(ctx.env, ctx.fleet, machine).first<{ base: string }>("SELECT base FROM bases WHERE sid = ? AND point = ?", i.sid, p.point);
      return { session: { ...session(row, machine), ...(spec ? { spec: JSON.parse(spec.spec) } : {}) }, point: { ...point(p), ...(base ? { base: base.base } : {}) }, files };
    },

    async "points.history"(i: { sid: string; point?: string; before?: string; limit?: number }, ctx) {
      const { machine } = await find(ctx, i.sid);
      const p = await pointOf(ctx.env, ctx.fleet, machine, i.sid, i.point);
      const file = transcript(JSON.parse(p.files) as FileIn[], i.sid);
      if (!file) return { events: [], more: false, point: p.point };
      const got = await page(ctx.env, ctx.fleet, machine, file, i.before, Math.min(i.limit ?? 50, 200));
      ctx.log.info("страница разговора архива", { machine, sid: i.sid, blocks: got.read, of: file.blocks.length });
      return { events: got.events as SdkEvent[], more: got.more, point: p.point };
    },

    async "points.calls"(i: { sid: string; point?: string }, ctx) {
      const { machine } = await find(ctx, i.sid);
      const [{ point: p, lines }, table] = await Promise.all([conversation(ctx.env, ctx.fleet, machine, i.sid, i.point), prices(ctx.env, ctx.fleet)]);
      const calls: ModelCall[] = callsOf(lines).map((c) => {
        const t = { input: c.input, output: c.output, cacheRead: c.cache_read, cacheWrite: c.cache_write };
        const cost = costOf(table, c.model, t);
        return { call: c.call, at: c.at, model: c.model, ...t, ...(cost !== undefined ? { cost } : {}) };
      });
      return { point: p.point, calls };
    },

    async "points.call"(i: { sid: string; point?: string; call: string; before?: number; limit?: number }, ctx) {
      const { machine } = await find(ctx, i.sid);
      const { point: p, lines } = await conversation(ctx.env, ctx.fleet, machine, i.sid, i.point);
      const text = callText(lines, i.call, i.before, Math.min(i.limit ?? 50, 200));
      if (!text) throw new Refusal("not_found", `вызова ${i.call} в разговоре точки нет`);
      return { point: p.point, call: i.call, ...text };
    },

    async "points.delete"(i: { sid: string; point?: string; expect?: string }, ctx) {
      const { machine } = await find(ctx, i.sid);
      // хозяин сессии архива — владелец её машины
      const owner = (await ctx.platform.machines(ctx.fleet)).find((m) => m.name === machine)?.owner;
      if (!ctx.who.admin && ctx.who.person !== owner) throw new Refusal("not_owner", `хозяин сессии — ${owner ?? "владелец машины " + machine}`);
      if (i.expect !== undefined) {
        const head = await pointOf(ctx.env, ctx.fleet, machine, i.sid);
        if (head.point !== i.expect) throw new Refusal("changed", `в архиве уже точка ${head.point}, а не ${i.expect}`);
      }
      if (i.point) await pointOf(ctx.env, ctx.fleet, machine, i.sid, i.point);
      const blocks = await drop(ctx.env, ctx.fleet, machine, i.sid, i.point ? [i.point] : "all");
      ctx.log.info("архив: удалено", { machine, sid: i.sid, point: i.point, blocks });
      return {};
    },
  },
};
