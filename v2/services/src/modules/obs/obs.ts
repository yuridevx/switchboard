// Наблюдение: одна строка на каждый запрос флота с исходом и временем по частям; ошибки страницы и Host; сводка здоровья;
// оповещение админам о сбоях частей и о высокой доле отказов. Хранится 7 дней.
import { errFields, type HostMetrics, type LedgerEvent, type Logger, machineOf, newId, type ObsRow, Refusal, type Who } from "@sb/protocol";
import type { Env, Module, Platform } from "../../env.ts";
import { records } from "../../records.ts";
import { fleetPref } from "../prefs/contract.ts";
import { sendTo } from "../reach/contract.ts";

const NAME = "obs";
const KEEP_MS = 7 * 24 * 3600 * 1000;
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS req (trace TEXT, at INTEGER, type TEXT, src TEXT, dst TEXT, ok INTEGER, word TEXT, why TEXT, ms INTEGER, spans TEXT)",
  "CREATE INDEX IF NOT EXISTS req_at ON req (at)",
  "CREATE INDEX IF NOT EXISTS req_trace ON req (trace)",
  "CREATE TABLE IF NOT EXISTS reports (at INTEGER, part TEXT, level TEXT, msg TEXT, stack TEXT, data TEXT, who TEXT)",
  // сбои частей: Host, Keeper, аналитика
  "CREATE TABLE IF NOT EXISTS fails (id TEXT PRIMARY KEY, at INTEGER, what TEXT, who TEXT, machine TEXT, text TEXT)",
  // когда о чём оповещали: одно оповещение на причину за промежуток
  "CREATE TABLE IF NOT EXISTS alerts (kind TEXT PRIMARY KEY, at INTEGER)",
  // числа Host по минутам: ряд на машину
  "CREATE TABLE IF NOT EXISTS hosts (machine TEXT, at INTEGER, data TEXT NOT NULL, PRIMARY KEY (machine, at))",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

type Stored = { trace: string; at: number; type: string; src: string; dst: string | null; ok: number; word: string | null; why: string | null; ms: number; spans: string | null };

/** Имя строки, которой в запросах видна ошибка, пойманная на месте. */
const REPORT = "report";
/** События журнала флота, которые считаются сбоем части. */
export const PART_FAILS = ["host.failed", "keeper.failed", "analytics.failed"];

/* ===== Оповещения =====
   Настройка флота `obs.alerts`: off — не оповещать; rate — доля отказов (0..1), выше которой звать; min — с какого числа запросов за окно её считать; to — кого звать (по умолчанию админы). */

type AlertPrefs = { off?: boolean; rate?: number; min?: number; to?: string[]; /** машина без связи дольше стольких минут — звать; 0 — не звать */ offline?: number; /** звать о сессии со сбоем; false — не звать */ failed?: boolean };
/** Машина без связи дольше этого — оповещение, если настройка не говорит иначе. */
const OFFLINE_MIN = 10;
/** Картину на сбои служба сверяет не чаще этого. */
const WATCH_MS = 60_000;
const RATE = 0.25, MIN = 20;
const WINDOW_MS = 5 * 60_000;
/** Одна причина — одно оповещение за этот промежуток. */
const GAP_MS = 30 * 60_000;

export interface Watch {
  platform: Platform;
  fetch: typeof fetch;
  log: Logger;
}

/** Позвать админов (или названных в настройке) о сбое. Та же причина в пределах получаса — молчит. */
async function alert(env: Env, fleet: string, w: Watch, kind: string, title: string, text: string, prefs?: AlertPrefs | null): Promise<number> {
  const p = prefs === undefined ? await fleetPref<AlertPrefs>(env, fleet, "obs.alerts") : prefs;
  if (p?.off) return 0;
  const now = Date.now();
  const fresh = await db(env, fleet).all("INSERT INTO alerts (kind, at) VALUES (?1, ?2) ON CONFLICT (kind) DO UPDATE SET at = excluded.at WHERE alerts.at < ?3 RETURNING kind", kind, now, now - GAP_MS);
  if (!fresh.length) return 0;
  const to = p?.to?.length ? p.to : await w.platform.admins(fleet);
  const sent = await Promise.all(to.map((person) => sendTo({ env, fleet, platform: w.platform, fetch: w.fetch, log: w.log }, { to: person, title, text, kind: "alert", force: true })));
  w.log.warn("оповещение о сбое", { module: NAME, fleet, kind, to: to.join(","), sent: sent.reduce((n, s) => n + s.sent, 0), why: text });
  return to.length;
}

/** Сверка картины флота: машина без связи дольше порога и сессия со сбоем — оповещение. Причина — этот уход машины и этот сбой сессии:
 *  пока они те же, второго оповещения нет. */
export async function watchFleet(env: Env, fleet: string, w: Watch): Promise<number> {
  const p = await fleetPref<AlertPrefs>(env, fleet, "obs.alerts");
  if (p?.off) return 0;
  const now = Date.now();
  const [machines, sessions] = await Promise.all([w.platform.machines(fleet), w.platform.sessions(fleet)]);
  let told = 0;
  const limit = (p?.offline ?? OFFLINE_MIN) * 60_000;
  if (limit > 0)
    for (const m of machines)
      if (!m.online && now - m.since >= limit)
        told += await alert(env, fleet, w, `machine.offline/${m.name}/${m.since}`, `Машина ${m.name} без связи`, `нет связи ${Math.round((now - m.since) / 60_000)} мин`, p);
  const gone = new Set(machines.filter((m) => !m.online).map((m) => m.name));
  if (p?.failed !== false)
    for (const s of sessions)
      // сессия машины без связи — последнее известное: о ней уже сказано уходом машины
      if (s.state === "failed" && !gone.has(machineOf(s.callsign) ?? ""))
        told += await alert(env, fleet, w, `session.failed/${s.callsign}/${s.last ?? s.since}`, `Сессия ${s.callsign}: сбой`, s.error ?? "причина не названа", p);
  return told;
}

/** Сбой части (Host, Keeper, аналитика): запомнить для сводки здоровья и позвать админов. */
export async function partFailed(env: Env, fleet: string, w: Watch, e: { what: string; who: string; machine?: string; text?: string }): Promise<void> {
  await db(env, fleet).batch([
    ["INSERT INTO fails (id, at, what, who, machine, text) VALUES (?, ?, ?, ?, ?, ?)", newId("f"), Date.now(), e.what, e.who, e.machine ?? null, e.text ?? null],
    ["DELETE FROM fails WHERE at < ?", Date.now() - KEEP_MS],
  ]);
  const part = e.what === "host.failed" ? "Host" : e.what === "keeper.failed" ? "Keeper" : "Аналитика";
  await alert(env, fleet, w, `${e.what}/${e.machine ?? ""}`, `${part}${e.machine ? ` машины ${e.machine}` : ""}: сбой`, e.text ?? e.what);
}

/** Строка запроса: пишет вход после ответа. Заодно убирает строки старше недели. Отказ — повод проверить долю отказов. */
export async function note(env: Env, fleet: string, r: ObsRow, w?: Watch): Promise<void> {
  const got = await db(env, fleet).batch([
    [
      "INSERT INTO req (trace, at, type, src, dst, ok, word, why, ms, spans) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.trace, r.at, r.type, r.from, r.to ?? null, r.ok ? 1 : 0, r.word ?? null, r.why ?? null, r.ms, r.spans ? JSON.stringify(r.spans) : null,
    ],
    ["DELETE FROM req WHERE at < ?", r.at - KEEP_MS],
    ["DELETE FROM reports WHERE at < ?", r.at - KEEP_MS],
    ["SELECT count(*) AS n, coalesce(sum(ok = 0), 0) AS failed FROM req WHERE at >= ? AND type != ?", r.at - WINDOW_MS, REPORT],
    // сверка картины — не чаще раза в минуту на флот
    ["INSERT INTO alerts (kind, at) VALUES ('watch', ?1) ON CONFLICT (kind) DO UPDATE SET at = excluded.at WHERE alerts.at < ?2 RETURNING kind", r.at, r.at - WATCH_MS],
    ["DELETE FROM alerts WHERE at < ?", r.at - KEEP_MS],
  ]);
  if (!w) return;
  if (got[4]!.length) await watchFleet(env, fleet, w).catch((e) => w.log.error("сверка картины не прошла", { module: NAME, fleet, ...errFields(e) }));
  if (r.ok) return;
  const { n, failed } = got[3]![0] as { n: number; failed: number };
  const p = await fleetPref<AlertPrefs>(env, fleet, "obs.alerts");
  if (n >= (p?.min ?? MIN) && failed / n >= (p?.rate ?? RATE))
    await alert(env, fleet, w, "rate", "Флот: много отказов", `${failed} из ${n} запросов за 5 минут отказаны; последний — ${r.type}: ${r.word ?? ""}${r.why ? ` (${r.why})` : ""}`, p).catch((e) =>
      w.log.error("оповещение не ушло", { module: NAME, fleet, ...errFields(e) }),
    );
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
    async "obs.recent"(i: { name?: string; failed?: boolean; of?: string; before?: number; limit?: number }, ctx) {
      const limit = Math.min(i.limit ?? 100, 500);
      const where = ["at < ?"];
      const params: (string | number)[] = [i.before ?? Number.MAX_SAFE_INTEGER];
      // name — имя запроса или его начало
      if (i.name) (where.push("substr(type, 1, length(?)) = ?"), params.push(i.name, i.name));
      if (i.failed) where.push("ok = 0");
      if (i.of) (where.push("trace = ?"), params.push(i.of));
      const got = await db(ctx.env, ctx.fleet).all<Stored>(`SELECT * FROM req WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT ?`, ...params, limit + 1);
      return { rows: got.slice(0, limit).filter(visible(ctx.who)).map(row), more: got.length > limit };
    },

    async "obs.stats"(i: { since: number; until: number }, ctx) {
      const all = await db(ctx.env, ctx.fleet).all<Pick<Stored, "type" | "dst" | "ok" | "ms" | "at">>("SELECT type, dst, ok, ms, at FROM req WHERE at >= ? AND at < ? AND type != ? ORDER BY at LIMIT 50000", i.since, i.until, REPORT);
      const got = all.filter(visible(ctx.who));
      const by = new Map<string, { n: number; failed: number; ms: number[] }>();
      const step = Math.max(1, Math.ceil((i.until - i.since) / 60));
      const buckets = new Map<number, { n: number; failed: number }>();
      for (const r of got) {
        const t = by.get(r.type) ?? { n: 0, failed: 0, ms: [] };
        t.n++;
        if (!r.ok) t.failed++;
        t.ms.push(r.ms);
        by.set(r.type, t);
        const at = i.since + Math.floor((r.at - i.since) / step) * step;
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

    /** Здоровье флота одним ответом: то, с чего начинают разбор, — без пяти отдельных запросов. */
    async "obs.health"(_i, ctx) {
      const now = Date.now();
      const sees = (m: string) => ctx.who.admin || ctx.who.machines.includes(m);
      const [machines, sessions, got] = await Promise.all([
        ctx.platform.machines(ctx.fleet),
        ctx.platform.sessions(ctx.fleet),
        db(ctx.env, ctx.fleet).batch([
          ["SELECT type, dst, ok, ms FROM req WHERE at >= ? AND type != ? LIMIT 50000", now - 3600_000, REPORT],
          ["SELECT * FROM fails WHERE at >= ? ORDER BY at DESC LIMIT 20", now - 24 * 3600_000],
          ["SELECT at, part, level, msg, who FROM reports WHERE at >= ? ORDER BY at DESC LIMIT 20", now - 24 * 3600_000],
          // последняя строка чисел каждой машины
          ["SELECT h.machine, h.data FROM hosts h JOIN (SELECT machine, max(at) AS at FROM hosts GROUP BY machine) l ON l.machine = h.machine AND l.at = h.at", ],
        ]),
      ]);
      const mine = machines.filter((m) => sees(m.name));
      const rows = (got[0] as unknown as Pick<Stored, "type" | "dst" | "ok" | "ms">[]).filter(visible(ctx.who));
      const by = new Map<string, number[]>();
      for (const r of rows) (by.get(r.type) ?? by.set(r.type, []).get(r.type)!).push(r.ms);
      const failed = rows.filter((r) => !r.ok).length;
      const seen = sessions.filter((s) => sees(machineOf(s.callsign) ?? ""));
      const failures = (got[1] as unknown as { id: string; at: number; what: string; who: string; machine: string | null; text: string | null }[])
        .filter((f) => !f.machine || sees(f.machine))
        .map((f): LedgerEvent => ({ id: f.id, at: f.at, what: f.what, who: f.who, ...(f.machine ? { machine: f.machine } : {}), ...(f.text ? { text: f.text } : {}) }));
      return {
        machines: { total: mine.length, online: mine.filter((m) => m.online).length, offline: mine.filter((m) => !m.online).map((m) => ({ name: m.name, since: m.since })) },
        sessions: { total: seen.length, failed: seen.filter((s) => s.state === "failed").map((s) => s.callsign), waiting: seen.filter((s) => s.state === "waiting").length },
        requests: { n: rows.length, failed, rate: rows.length ? failed / rows.length : 0 },
        slow: [...by]
          .map(([type, ms]) => (ms.sort((a, b) => a - b), { type, p95: quantile(ms, 0.95), n: ms.length }))
          .sort((a, b) => b.p95 - a.p95)
          .slice(0, 5),
        failures,
        reports: got[2] as unknown as { at: number; part: string; level: string; msg: string; who: string }[],
        hosts: (got[3] as unknown as { machine: string; data: string }[]).filter((h) => sees(h.machine)).map((h) => ({ ...(JSON.parse(h.data) as HostMetrics), machine: h.machine })),
      };
    },

    /** Числа Host за минуту от машины: строка ряда; старше недели — убрать. Заодно сверка картины: это единственный такт, который идёт и без запросов людей. */
    async "obs.metrics"(i: HostMetrics, ctx) {
      const machine = machineOf(ctx.who.addr)!;
      await db(ctx.env, ctx.fleet).batch([
        ["INSERT OR REPLACE INTO hosts (machine, at, data) VALUES (?, ?, ?)", machine, i.at, JSON.stringify(i)],
        ["DELETE FROM hosts WHERE at < ?", Date.now() - KEEP_MS],
      ]);
      const due = await db(ctx.env, ctx.fleet).all("INSERT INTO alerts (kind, at) VALUES ('watch', ?1) ON CONFLICT (kind) DO UPDATE SET at = excluded.at WHERE alerts.at < ?2 RETURNING kind", Date.now(), Date.now() - WATCH_MS);
      if (due.length) await watchFleet(ctx.env, ctx.fleet, { platform: ctx.platform, fetch: ctx.fetch, log: ctx.log });
      return {};
    },

    async "obs.series"(i: { machine: string; since?: number; until?: number; limit?: number }, ctx) {
      if (!ctx.who.admin && !ctx.who.machines.includes(i.machine)) throw new Refusal("forbidden", `до машины ${i.machine} вы не достаёте`);
      const rows = await db(ctx.env, ctx.fleet).all<{ data: string }>(
        "SELECT data FROM (SELECT at, data FROM hosts WHERE machine = ? AND at >= ? AND at < ? ORDER BY at DESC LIMIT ?) ORDER BY at",
        i.machine, i.since ?? 0, i.until ?? Number.MAX_SAFE_INTEGER, Math.min(i.limit ?? 1440, 10_080),
      );
      return { rows: rows.map((r) => JSON.parse(r.data) as HostMetrics) };
    },

    async "obs.report"(i: { part: string; level: "warn" | "error"; msg: string; stack?: string; data?: unknown }, ctx) {
      const now = Date.now();
      await db(ctx.env, ctx.fleet).batch([
        ["INSERT INTO reports (at, part, level, msg, stack, data, who) VALUES (?, ?, ?, ?, ?, ?, ?)", now, i.part, i.level, i.msg, i.stack ?? null, i.data === undefined ? null : JSON.stringify(i.data), ctx.who.addr],
        // та же ошибка — строкой среди запросов: разбор идёт по одному списку
        ["INSERT INTO req (trace, at, type, src, dst, ok, word, why, ms, spans) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 0, NULL)", ctx.trace, now, REPORT, ctx.who.addr, i.level, `${i.part}: ${i.msg}`],
      ]);
      const fields = { reported: i.part, from: ctx.who.addr, stack: i.stack };
      if (i.level === "error") ctx.log.error(i.msg, fields);
      else ctx.log.warn(i.msg, fields);
      return {};
    },
  },
};
