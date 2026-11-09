// Архив сессий: точки. Блоки файлов — в R2 под именем хэша содержимого; реестр и текст сообщений с поиском по словам —
// в записях на машину. Поиск опрашивает только машины, до которых человек достаёт.
import { type ArchPoint, type ArchSession, canReach, errFields, machineOf, Refusal, type SdkEvent } from "@sb/protocol";
import type { Ctx, Env, Module } from "../env.ts";
import { link, readBlocks } from "../r2.ts";
import { type Op, records } from "../records.ts";

const NAME = "archive";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, callsign TEXT, title TEXT, model TEXT, cwd TEXT, project TEXT, last INTEGER, points INTEGER, bytes INTEGER, tokens INTEGER)",
  "CREATE TABLE IF NOT EXISTS points (sid TEXT, point TEXT, at INTEGER, label TEXT, turns INTEGER, bytes INTEGER, git TEXT, files TEXT NOT NULL, PRIMARY KEY (sid, point))",
  "CREATE TABLE IF NOT EXISTS msg (id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, sid TEXT, role TEXT)",
  "CREATE INDEX IF NOT EXISTS msg_sid ON msg (sid)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS msgs USING fts5 (body, tokenize = 'unicode61')",
];
const db = (env: Env, fleet: string, machine: string) => records(env, fleet, NAME, SCHEMA, machine);

const HASH = /^[0-9a-f]{64}$/;
const TEXT_MAX = 20_000;
const HEADS_AT_ONCE = 50;

export const blockKey = (fleet: string, hash: string) => `blocks/${fleet}/${hash}`;

type FileIn = { path: string; blocks: string[]; size: number };
type SessionRow = { sid: string; callsign: string; title: string | null; model: string | null; cwd: string | null; project: string | null; last: number; points: number; bytes: number | null; tokens: number | null };
type PointRow = { sid: string; point: string; at: number; label: string | null; turns: number | null; bytes: number | null; git: string | null; files: string };

const session = (s: SessionRow, machine: string, hit?: string): ArchSession => ({
  sid: s.sid, machine, callsign: s.callsign, points: s.points, last: s.last,
  ...(s.title ? { title: s.title } : {}), ...(s.model ? { model: s.model } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), ...(s.project ? { project: s.project } : {}),
  ...(s.bytes != null ? { bytes: s.bytes } : {}), ...(s.tokens != null ? { tokens: s.tokens } : {}), ...(hit ? { hit } : {}),
});
const point = (p: PointRow): ArchPoint => ({
  point: p.point, at: p.at,
  ...(p.label ? { label: p.label } : {}), ...(p.turns != null ? { turns: p.turns } : {}), ...(p.bytes != null ? { bytes: p.bytes } : {}), ...(p.git ? { git: p.git } : {}),
});

/** Каких блоков ещё нет в хранилище. */
async function missing(env: Env, fleet: string, hashes: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < hashes.length; i += HEADS_AT_ONCE) {
    const part = hashes.slice(i, i + HEADS_AT_ONCE);
    const heads = await Promise.all(part.map((h) => env.FILES.head(blockKey(fleet, h))));
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

/** Строки разговора точки: для истории и для аналитики. Файла разговора нет — пусто. */
export async function conversation(env: Env, fleet: string, machine: string, sid: string, name?: string): Promise<{ point: PointRow; session: SessionRow | null; lines: Record<string, unknown>[] }> {
  const p = await pointOf(env, fleet, machine, sid, name);
  const s = await db(env, fleet, machine).first<SessionRow>("SELECT * FROM sessions WHERE sid = ?", sid);
  const file = transcript(JSON.parse(p.files) as FileIn[], sid);
  if (!file) return { point: p, session: s, lines: [] };
  const text = new TextDecoder().decode(await readBlocks(env, file.blocks.map((h) => blockKey(fleet, h))));
  const lines: Record<string, unknown>[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object" && typeof v.type === "string") lines.push(v);
    } catch {
      // оборванная последняя строка файла — не событие
    }
  }
  return { point: p, session: s, lines };
}

/** Точки машины с этого момента: для доливки аналитики. */
export const pointsSince = (env: Env, fleet: string, machine: string, from: number) => db(env, fleet, machine).all<{ sid: string; point: string }>("SELECT sid, point FROM points WHERE at >= ? ORDER BY at", from);

/** Слова запроса — в запрос полнотекстового поиска: каждое слово целиком, все сразу. */
const match = (q: string) => q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");

export const archive: Module = {
  name: NAME,
  handlers: {
    async "points.put"(i: {
      sid: string; callsign: string; point: string; label?: string; title?: string; model?: string; cwd?: string; project?: string; git?: string; turns?: number; tokens?: number;
      files: FileIn[]; text?: { uuid: string; role: string; text: string }[]; commit?: boolean;
    }, ctx) {
      const machine = machineOf(ctx.who.addr)!;
      const hashes = [...new Set(i.files.flatMap((f) => f.blocks))];
      const bad = hashes.find((h) => !HASH.test(h));
      if (bad) throw new Refusal("bad_input", `блок ${bad} — не хэш SHA-256`);
      const need = await missing(ctx.env, ctx.fleet, hashes);
      if (need.length) {
        if (i.commit) throw new Refusal("blocks_missing", `не загружено блоков: ${need.length}`);
        const upload: Record<string, string> = {};
        for (const h of need) upload[h] = await link(ctx.env, "PUT", blockKey(ctx.fleet, h));
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
        ["UPDATE sessions SET points = (SELECT count(*) FROM points WHERE sid = ?1) WHERE sid = ?1", i.sid],
      ];
      for (const m of i.text ?? []) {
        ops.push(["INSERT OR IGNORE INTO msg (uuid, sid, role) VALUES (?, ?, ?)", m.uuid, i.sid, m.role]);
        ops.push(["INSERT INTO msgs (rowid, body) SELECT id, ?1 FROM msg WHERE uuid = ?2 AND NOT EXISTS (SELECT 1 FROM msgs WHERE msgs.rowid = msg.id)", m.text.slice(0, TEXT_MAX), m.uuid]);
      }
      await db(ctx.env, ctx.fleet, machine).batch(ops);
      // аналитика в стороне: записка не ушла — точка всё равно сохранена
      try {
        await ctx.env.ANALYTICS.send({ fleet: ctx.fleet, machine, sid: i.sid, point: i.point });
      } catch (e) {
        ctx.log.warn("записка аналитике не ушла", { machine, ...errFields(e) });
      }
      return { upload: {}, done: true };
    },

    async "points.list"(i: { q?: string; machine?: string; sid?: string; before?: number; limit?: number }, ctx) {
      const limit = Math.min(i.limit ?? 50, 200);
      const before = i.before ?? Number.MAX_SAFE_INTEGER;
      if (i.sid) {
        const { machine, row } = i.machine ? await (async () => {
          const [m] = machinesOf(ctx, i.machine);
          const r = await db(ctx.env, ctx.fleet, m!).first<SessionRow>("SELECT * FROM sessions WHERE sid = ?", i.sid!);
          if (!r) throw new Refusal("not_found", `сессии ${i.sid} в архиве нет`);
          return { machine: m!, row: r };
        })() : await find(ctx, i.sid);
        const pts = await db(ctx.env, ctx.fleet, machine).all<PointRow>("SELECT * FROM points WHERE sid = ? ORDER BY at DESC", i.sid);
        return { sessions: [session(row, machine)], points: pts.map(point), more: false };
      }
      const words = i.q ? match(i.q) : "";
      const per = await Promise.all(
        machinesOf(ctx, i.machine).map(async (m) => {
          const d = db(ctx.env, ctx.fleet, m);
          if (!words) return (await d.all<SessionRow>("SELECT * FROM sessions WHERE last < ? ORDER BY last DESC LIMIT ?", before, limit + 1)).map((s) => session(s, m));
          const hits = await d.all<{ sid: string; hit: string }>("SELECT msg.sid AS sid, snippet(msgs, 0, '', '', '…', 16) AS hit FROM msgs JOIN msg ON msg.id = msgs.rowid WHERE msgs MATCH ? LIMIT 1000", words);
          const first = new Map<string, string>();
          for (const h of hits) if (!first.has(h.sid)) first.set(h.sid, h.hit);
          if (!first.size) return [];
          const rows = await d.all<SessionRow>(`SELECT * FROM sessions WHERE last < ? AND sid IN (${[...first.keys()].map(() => "?").join(",")}) ORDER BY last DESC LIMIT ?`, before, ...first.keys(), limit + 1);
          return rows.map((s) => session(s, m, first.get(s.sid)));
        }),
      );
      const all = per.flat().sort((a, b) => b.last - a.last);
      return { sessions: all.slice(0, limit), more: all.length > limit };
    },

    async "points.get"(i: { sid: string; point?: string }, ctx) {
      const { machine, row } = await find(ctx, i.sid);
      const p = await pointOf(ctx.env, ctx.fleet, machine, i.sid, i.point);
      const files = [];
      for (const f of JSON.parse(p.files) as FileIn[]) {
        const blocks = [];
        for (const hash of f.blocks) blocks.push({ hash, url: await link(ctx.env, "GET", blockKey(ctx.fleet, hash)) });
        files.push({ path: f.path, size: f.size, blocks });
      }
      return { session: session(row, machine), point: point(p), files };
    },

    async "points.history"(i: { sid: string; point?: string; before?: string; limit?: number }, ctx) {
      const { machine } = await find(ctx, i.sid);
      const { lines } = await conversation(ctx.env, ctx.fleet, machine, i.sid, i.point);
      const limit = Math.min(i.limit ?? 50, 200);
      const cut = i.before ? lines.findIndex((l) => l.uuid === i.before) : -1;
      const upto = cut >= 0 ? lines.slice(0, cut) : lines;
      return { events: upto.slice(-limit) as SdkEvent[], more: upto.length > limit };
    },

    async "points.delete"(i: { sid: string; point?: string }, ctx) {
      const { machine } = await find(ctx, i.sid);
      const d = db(ctx.env, ctx.fleet, machine);
      if (i.point)
        await d.batch([
          ["DELETE FROM points WHERE sid = ? AND point = ?", i.sid, i.point],
          ["UPDATE sessions SET points = (SELECT count(*) FROM points WHERE sid = ?1) WHERE sid = ?1", i.sid],
        ]);
      else
        await d.batch([
          ["DELETE FROM msgs WHERE rowid IN (SELECT id FROM msg WHERE sid = ?)", i.sid],
          ["DELETE FROM msg WHERE sid = ?", i.sid],
          ["DELETE FROM points WHERE sid = ?", i.sid],
          ["DELETE FROM sessions WHERE sid = ?", i.sid],
        ]);
      return {};
    },
  },
};
