// Аналитика — ClickHouse в стороне: вызовы модели и расход. Главной копии в нём нет: строки получены из блоков архива и доливаются заново.
// Его отказ ломает только отчёты: точки, подъём и поиск от него не зависят.
import { canReach, errFields, Refusal } from "@sb/protocol";
import type { Ctx, Deps, Env, Module, PointNote } from "../env.ts";
import { log } from "../entrance.ts";
import { conversation, pointsSince } from "./archive.ts";
import { record } from "./ledger.ts";

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
    headers: { authorization: "Basic " + btoa(`${env.CH_USER ?? "default"}:${env.CH_PASSWORD ?? ""}`) },
    body: body ?? "",
    signal: AbortSignal.timeout(CH_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ответил ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

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

/** Одна точка — в ClickHouse. Повторная подача строк не прибавляет: ключ строки — флот, машина, сессия и номер вызова. */
async function feed(env: Env, deps: Deps, n: PointNote): Promise<number> {
  const f = deps.fetch ?? fetch;
  const { session, lines } = await conversation(env, n.fleet, n.machine, n.sid, n.point);
  const calls = callsOf(lines);
  if (!calls.length) return 0;
  const owner = (await (deps.platform ?? env.PLATFORM).machines(n.fleet)).find((m) => m.name === n.machine)?.owner ?? "";
  if (!created) {
    await ch(env, f, CREATE);
    created = true;
  }
  const rows = calls.map((c) => JSON.stringify({ fleet: n.fleet, machine: n.machine, owner, sid: n.sid, callsign: session?.callsign ?? "", project: session?.project ?? "", ...c }));
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
      await record(env, m.body.fleet, { what: "analytics.failed", who: ".analytics", machine: m.body.machine, text: e instanceof Error ? e.message : String(e), data: { sid: m.body.sid, point: m.body.point } });
      m.ack();
    }
  }
}

const KEY: Record<string, string> = { day: "toString(toDate(at))", model: "model", machine: "machine", session: "callsign", person: "owner", project: "project" };

export const analytics: Module = {
  name: NAME,
  handlers: {
    async "analytics.query"(i: { by: string; from: string; to: string; machine?: string }, ctx: Ctx) {
      if (!ctx.env.CH_URL) throw new Refusal("analytics_unavailable", "аналитика не подключена");
      if (i.machine && !canReach(ctx.who, i.machine)) throw new Refusal("forbidden", `до машины ${i.machine} вы не достаёте`);
      const machines = i.machine ? [i.machine] : ctx.who.machines;
      const query = `SELECT ${KEY[i.by]} AS key, count() AS calls, sum(input) AS input, sum(output) AS output, sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite
        FROM ${TABLE} FINAL WHERE fleet = {fleet:String} AND has({machines:Array(String)}, machine) AND at >= parseDateTimeBestEffort({from:String}) AND at < parseDateTimeBestEffort({to:String})
        GROUP BY key ORDER BY key FORMAT JSON`;
      let text: string;
      try {
        text = await ch(ctx.env, ctx.fetch, query, undefined, { fleet: ctx.fleet, machines: `[${machines.map((m) => `'${m}'`).join(",")}]`, from: i.from, to: i.to });
      } catch (e) {
        throw new Refusal("analytics_unavailable", e instanceof Error ? e.message : String(e));
      }
      const data = (JSON.parse(text) as { data: Record<string, string | number>[] }).data;
      return { rows: data.map((r) => ({ key: String(r.key), calls: Number(r.calls), input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cacheRead), cacheWrite: Number(r.cacheWrite) })) };
    },

    /** Доливка: точки архива с этого момента — снова в очередь. */
    async "analytics.fill"(i: { from: number }, ctx: Ctx) {
      let queued = 0;
      for (const m of await ctx.platform.machines(ctx.fleet))
        for (const p of await pointsSince(ctx.env, ctx.fleet, m.name, i.from)) {
          await ctx.env.ANALYTICS.send({ fleet: ctx.fleet, machine: m.name, sid: p.sid, point: p.point });
          queued++;
        }
      return { queued };
    },
  },
};
