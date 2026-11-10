// Аналитика — ClickHouse в стороне: вызовы модели и расход. Главной копии в нём нет: строки получены из блоков архива и доливаются заново.
// Его отказ ломает только отчёты: точки, подъём и поиск от него не зависят.
import { canReach, errFields, Refusal } from "@sb/protocol";
import { outbound } from "../../env.ts";
import type { Ctx, Deps, Env, Module, PointNote } from "../../env.ts";
import { log } from "../../entrance.ts";
import { callsOf, conversation, costOf, pointsSince, prices } from "../archive/contract.ts";
import { record } from "../ledger/contract.ts";
import { partFailed } from "../obs/contract.ts";

const NAME = "analytics";
const TABLE = "sb2_calls";
const CH_MS = 30_000;
/** После стольких подач очередь больше не повторяет: строка в журнал флота, пропущенное доливает агент. */
const TRIES = 3;

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (fleet String, machine String, owner String, sid String, callsign String, project String, call String, at DateTime64(3),
  model String, input UInt64, output UInt64, cache_read UInt64, cache_write UInt64) ENGINE = ReplacingMergeTree ORDER BY (fleet, machine, sid, call)`;

/** Таблица заведена в этом экземпляре Worker'а. */
let created = false;

async function ch(env: Env, f: typeof fetch, query: string, body?: string, params: Record<string, string> = {}): Promise<string> {
  const url = new URL(env.CH_URL!);
  url.searchParams.set("query", query);
  for (const [k, v] of Object.entries(params)) url.searchParams.set("param_" + k, v);
  const res = await f(url, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.CH_USER ?? "default"}:${env.CH_PASSWORD ?? ""}`),
      // ClickHouse за Cloudflare Access: служебный токен входа, если он задан
      ...(env.CH_ACCESS_ID && env.CH_ACCESS_SECRET ? { "CF-Access-Client-Id": env.CH_ACCESS_ID, "CF-Access-Client-Secret": env.CH_ACCESS_SECRET } : {}),
    },
    body: body ?? "",
    signal: AbortSignal.timeout(CH_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ответил ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

/** Одна точка — в ClickHouse. Повторная подача строк не прибавляет: ключ строки — флот, машина, сессия и номер вызова. */
async function feed(env: Env, deps: Deps, n: PointNote): Promise<number> {
  const f = deps.fetch ?? outbound;
  const { session, lines } = await conversation(env, n.fleet, n.machine, n.sid, n.point);
  const calls = callsOf(lines);
  if (!calls.length) return 0;
  const owner = (await (deps.platform ?? env.PLATFORM).machines(n.fleet)).find((m) => m.name === n.machine)?.owner ?? "";
  if (!created) {
    await ch(env, f, CREATE);
    created = true;
  }
  const rows = calls.map((c) => JSON.stringify({ fleet: n.fleet, machine: n.machine, owner, sid: n.sid, callsign: session?.callsign ?? "", project: session?.project ?? "", ...c, at: c.at / 1000 })); // ClickHouse читает число как секунды: время вызова у нас в миллисекундах
  await ch(env, f, `INSERT INTO ${TABLE} FORMAT JSONEachRow`, rows.join("\n"));
  return rows.length;
}

/** Потребитель очереди. ClickHouse не принял — очередь повторяет; не принял и после повторов — строка в журнал флота. */
export async function consume(batch: MessageBatch<PointNote>, env: Env, deps: Deps = {}): Promise<void> {
  for (const m of batch.messages) {
    if (!env.CH_URL) {
      m.ack();
      continue;
    }
    try {
      const rows = await feed(env, deps, m.body);
      log.info("точка в аналитике", { module: NAME, fleet: m.body.fleet, machine: m.body.machine, rows });
      m.ack();
    } catch (e) {
      if (m.attempts < TRIES) {
        m.retry();
        continue;
      }
      log.error("аналитика не приняла точку", { module: NAME, fleet: m.body.fleet, machine: m.body.machine, ...errFields(e) });
      const text = e instanceof Error ? e.message : String(e);
      await record(env, m.body.fleet, { what: "analytics.failed", who: ".analytics", machine: m.body.machine, text, data: { sid: m.body.sid, point: m.body.point } });
      await partFailed(env, m.body.fleet, { platform: deps.platform ?? env.PLATFORM, fetch: deps.fetch ?? outbound, log }, { what: "analytics.failed", who: ".analytics", machine: m.body.machine, text }).catch((x) =>
        log.error("оповещение о сбое аналитики не ушло", { module: NAME, fleet: m.body.fleet, ...errFields(x) }),
      );
      m.ack();
    }
  }
}

const KEY: Record<string, string> = { day: "toString(toDate(at))", model: "model", machine: "machine", session: "callsign", person: "owner", project: "project" };

export const analytics: Module = {
  name: NAME,
  handlers: {
    async "analytics.query"(i: { by: string; since: string; until: string; machine?: string }, ctx: Ctx) {
      if (!ctx.env.CH_URL) throw new Refusal("analytics_unavailable", "аналитика не подключена");
      if (i.machine && !canReach(ctx.who, i.machine)) throw new Refusal("forbidden", `до машины ${i.machine} вы не достаёте`);
      const machines = i.machine ? [i.machine] : ctx.who.machines;
      // разрез и модель: стоимость считается по модели, затем складывается по разрезу
      const query = `SELECT ${KEY[i.by]} AS key, model, count() AS calls, sum(input) AS input, sum(output) AS output, sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite
        FROM ${TABLE} FINAL WHERE fleet = {fleet:String} AND has({machines:Array(String)}, machine) AND at >= parseDateTimeBestEffort({from:String}) AND at < parseDateTimeBestEffort({to:String})
        GROUP BY key, model ORDER BY key FORMAT JSON`;
      let text: string;
      try {
        text = await ch(ctx.env, ctx.fetch, query, undefined, { fleet: ctx.fleet, machines: `[${machines.map((m) => `'${m}'`).join(",")}]`, from: i.since, to: i.until });
      } catch (e) {
        throw new Refusal("analytics_unavailable", e instanceof Error ? e.message : String(e));
      }
      const data = (JSON.parse(text) as { data: Record<string, string | number>[] }).data;
      const table = await prices(ctx.env, ctx.fleet);
      const rows = new Map<string, { key: string; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }>();
      for (const r of data) {
        const t = { input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cacheRead), cacheWrite: Number(r.cacheWrite) };
        const cost = costOf(table, String(r.model ?? ""), t);
        const row = rows.get(String(r.key)) ?? { key: String(r.key), calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        row.calls += Number(r.calls);
        for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) row[k] += t[k];
        // стоимость — только по моделям с известной ценой
        if (cost !== undefined) row.cost = (row.cost ?? 0) + cost;
        rows.set(row.key, row);
      }
      return { rows: [...rows.values()] };
    },

    /** Состояние: один запрос в ClickHouse и счёт точек архива новее его последней строки по каждой машине. */
    async "analytics.state"(_i: unknown, ctx: Ctx) {
      if (!ctx.env.CH_URL) return { on: false, ok: false, machines: [] };
      const started = Date.now();
      let data: Array<{ machine: string; rows: string | number; last: string | number }>;
      try {
        const text = await ch(ctx.env, ctx.fetch, `SELECT machine, count() AS rows, toUnixTimestamp64Milli(max(at)) AS last FROM ${TABLE} FINAL WHERE fleet = {fleet:String} GROUP BY machine FORMAT JSON`, undefined, { fleet: ctx.fleet });
        data = (JSON.parse(text) as { data: typeof data }).data;
      } catch (e) {
        return { on: true, ok: false, error: e instanceof Error ? e.message : String(e), machines: [] };
      }
      const ms = Date.now() - started;
      const machines = await Promise.all(ctx.who.machines.map(async (machine) => {
        const row = data.find((r) => r.machine === machine);
        const last = Number(row?.last ?? 0);
        return { machine, rows: Number(row?.rows ?? 0), ...(last ? { last } : {}), pending: (await pointsSince(ctx.env, ctx.fleet, machine, last + 1)).length };
      }));
      return { on: true, ok: true, ms, machines };
    },

    /** Доливка: точки архива с этого момента — снова в очередь. */
    async "analytics.fill"(i: { since: number }, ctx: Ctx) {
      let queued = 0;
      for (const m of await ctx.platform.machines(ctx.fleet))
        for (const p of await pointsSince(ctx.env, ctx.fleet, m.name, i.since)) {
          await ctx.env.ANALYTICS.send({ fleet: ctx.fleet, machine: m.name, sid: p.sid, point: p.point });
          queued++;
        }
      return { queued };
    },
  },
};
