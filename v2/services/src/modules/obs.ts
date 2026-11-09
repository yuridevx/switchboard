// Наблюдение: одна строка на каждый запрос флота с исходом и временем по частям; ошибки страницы и Host. Хранится 7 дней.
import { machineOf, type ObsRow, type Who } from "@sb/protocol";
import type { Env, Module } from "../env.ts";
import { records } from "../records.ts";

const NAME = "obs";
const KEEP_MS = 7 * 24 * 3600 * 1000;
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS req (trace TEXT, at INTEGER, type TEXT, src TEXT, dst TEXT, ok INTEGER, word TEXT, why TEXT, ms INTEGER, spans TEXT)",
  "CREATE INDEX IF NOT EXISTS req_at ON req (at)",
  "CREATE INDEX IF NOT EXISTS req_trace ON req (trace)",
  "CREATE TABLE IF NOT EXISTS reports (at INTEGER, part TEXT, level TEXT, msg TEXT, stack TEXT, data TEXT, who TEXT)",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

type Stored = { trace: string; at: number; type: string; src: string; dst: string | null; ok: number; word: string | null; why: string | null; ms: number; spans: string | null };

/** Строка запроса: пишет вход после ответа. Заодно убирает строки старше недели. */
export async function note(env: Env, fleet: string, r: ObsRow): Promise<void> {
  await db(env, fleet).batch([
    [
      "INSERT INTO req (trace, at, type, src, dst, ok, word, why, ms, spans) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.trace, r.at, r.type, r.from, r.to ?? null, r.ok ? 1 : 0, r.word ?? null, r.why ?? null, r.ms, r.spans ? JSON.stringify(r.spans) : null,
    ],
    ["DELETE FROM req WHERE at < ?", r.at - KEEP_MS],
    ["DELETE FROM reports WHERE at < ?", r.at - KEEP_MS],
  ]);
}

const row = (s: Stored): ObsRow => ({
  trace: s.trace, at: s.at, type: s.type, from: s.src, ok: !!s.ok, ms: s.ms,
  ...(s.dst ? { to: s.dst } : {}), ...(s.word ? { word: s.word } : {}), ...(s.why ? { why: s.why } : {}), ...(s.spans ? { spans: JSON.parse(s.spans) } : {}),
});

/** Строку о чужой машине видит только тот, кто до неё достаёт, и админ. */
const visible = (who: Who) => (s: Pick<Stored, "dst">) => {
  if (who.admin || !s.dst) return true;
  const m = machineOf(s.dst);
  return !m || who.machines.includes(m);
};

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);

export const obs: Module = {
  name: NAME,
  handlers: {
    async "obs.recent"(i: { type?: string; failed?: boolean; trace?: string; before?: number; limit?: number }, ctx) {
      const limit = Math.min(i.limit ?? 100, 500);
      const where = ["at < ?"];
      const params: (string | number)[] = [i.before ?? Number.MAX_SAFE_INTEGER];
      if (i.type) (where.push("type = ?"), params.push(i.type));
      if (i.failed) where.push("ok = 0");
      if (i.trace) (where.push("trace = ?"), params.push(i.trace));
      const got = await db(ctx.env, ctx.fleet).all<Stored>(`SELECT * FROM req WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT ?`, ...params, limit + 1);
      return { rows: got.slice(0, limit).filter(visible(ctx.who)).map(row), more: got.length > limit };
    },

    async "obs.stats"(i: { from: number; to: number }, ctx) {
      const all = await db(ctx.env, ctx.fleet).all<Pick<Stored, "type" | "dst" | "ok" | "ms" | "at">>("SELECT type, dst, ok, ms, at FROM req WHERE at >= ? AND at < ? ORDER BY at LIMIT 50000", i.from, i.to);
      const got = all.filter(visible(ctx.who));
      const by = new Map<string, { n: number; failed: number; ms: number[] }>();
      const step = Math.max(1, Math.ceil((i.to - i.from) / 60));
      const buckets = new Map<number, { n: number; failed: number }>();
      for (const r of got) {
        const t = by.get(r.type) ?? { n: 0, failed: 0, ms: [] };
        t.n++;
        if (!r.ok) t.failed++;
        t.ms.push(r.ms);
        by.set(r.type, t);
        const at = i.from + Math.floor((r.at - i.from) / step) * step;
        const b = buckets.get(at) ?? { n: 0, failed: 0 };
        b.n++;
        if (!r.ok) b.failed++;
        buckets.set(at, b);
      }
      return {
        types: [...by]
          .map(([type, t]) => {
            t.ms.sort((a, b) => a - b);
            return { type, n: t.n, failed: t.failed, p50: quantile(t.ms, 0.5), p95: quantile(t.ms, 0.95) };
          })
          .sort((a, b) => b.n - a.n),
        buckets: [...buckets].map(([at, b]) => ({ at, ...b })).sort((a, b) => a.at - b.at),
      };
    },

    async "obs.report"(i: { part: string; level: "warn" | "error"; msg: string; stack?: string; data?: unknown }, ctx) {
      await db(ctx.env, ctx.fleet).run(
        "INSERT INTO reports (at, part, level, msg, stack, data, who) VALUES (?, ?, ?, ?, ?, ?, ?)",
        Date.now(), i.part, i.level, i.msg, i.stack ?? null, i.data === undefined ? null : JSON.stringify(i.data), ctx.who.addr,
      );
      const fields = { reported: i.part, from: ctx.who.addr, stack: i.stack };
      if (i.level === "error") ctx.log.error(i.msg, fields);
      else ctx.log.warn(i.msg, fields);
      return {};
    },
  },
};
