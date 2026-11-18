// Аналитика — ClickHouse в стороне: вызовы модели, расход и история флота. Главной копии в нём нет: вызовы получены из блоков архива и доливаются заново,
// история — из файлов журнала машин: машина шлёт их пачками с места остановки. Его отказ ломает только отчёты и чтение истории:
// точки, подъём, поиск и вызовы модели от него не зависят.
import { canReach, errFields, machineOf, Refusal, type LogRow } from "@sb/protocol";
import { outbound } from "../../env.ts";
import type { Ctx, Deps, Env, Module, PointNote } from "../../env.ts";
import { log } from "../../env.ts";
import { callsOf, conversation, costOf, pointsSince, prices } from "../archive/contract.ts";
import { record } from "../ledger/contract.ts";
import { partFailed } from "../obs/contract.ts";

const NAME = "analytics";
const TABLE = "sb2_calls";
const CH_MS = 30_000;
/** После стольких подач очередь больше не повторяет: строка в журнал флота, пропущенное доливает агент. */
const TRIES = 3;

/** req — номер запроса Claude: по нему вызов соединяется со строкой вызова журнала машины. */
const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (fleet String, machine String, owner String, sid String, callsign String, project String, call String, at DateTime64(3),
  model String, input UInt64, output UInt64, cache_read UInt64, cache_write UInt64, req String) ENGINE = ReplacingMergeTree ORDER BY (fleet, machine, sid, call)`;

/** История флота: строки журналов машин. Ключ строки — машина, файл журнала, начало пачки в файле и номер строки в пачке: повтор пачки строк не добавляет. */
const LOG = "sb2_log";
const CREATE_LOG = `CREATE TABLE IF NOT EXISTS ${LOG} (fleet String, machine String, file String, pos UInt64, n UInt32, at DateTime64(3), part String, level String, msg String,
  session String, account String, status UInt16, kind String, text String, data String) ENGINE = ReplacingMergeTree ORDER BY (fleet, machine, file, pos, n)`;
/** Поля строки журнала, у которых своя колонка; остальные идут в data. */
const COLUMNS = new Set(["t", "part", "level", "msg", "callsign", "account", "status", "kind", "why", "fleet", "machine"]);
/** Отбор по уровню — как у журнала машины: этот уровень и выше. */
const LEVELS: Record<string, string[]> = { info: ["info", "warn", "error"], warn: ["warn", "error"], error: ["error"] };

/** Таблицы, заведённые в этом экземпляре Worker'а. */
const created = new Set<string>();
async function ensure(env: Env, f: typeof fetch, table: string, ddl: string): Promise<void> {
  if (created.has(table)) return;
  await ch(env, f, ddl);
  created.add(table);
}

/** Строка журнала машины → строка истории; недописанная строка — не запись. */
function logRow(fleet: string, machine: string, file: string, pos: number, n: number, text: string): string | null {
  let l: Record<string, unknown> | null;
  try {
    l = JSON.parse(text) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!l || typeof l.t !== "number" || typeof l.msg !== "string") return null;
  const rest = Object.fromEntries(Object.entries(l).filter(([k]) => !COLUMNS.has(k)));
  const word = (v: unknown) => (typeof v === "string" ? v : "");
  return JSON.stringify({
    fleet, machine, file, pos, n, at: l.t / 1000, part: word(l.part), level: word(l.level), msg: l.msg, session: word(l.callsign), account: word(l.account),
    status: typeof l.status === "number" ? l.status : 0, kind: word(l.kind), text: word(l.why), data: Object.keys(rest).length ? JSON.stringify(rest) : "",
  });
}

/** Строка журнала о вызове инструмента сервером MCP: msg tool, сессия — кто звал, машина — его машина; в data — инструмент, знаков ответа, время.
 *  Ключ строки — время и случайный номер: повторов у неё нет. Аналитика не подключена — строки нет. */
export async function toolLine(env: Env, f: typeof fetch, fleet: string, machine: string, l: { tool: string; from: string; ms: number; ok: boolean; chars: number; images?: number; trace?: string }): Promise<void> {
  if (!env.CH_URL) return;
  const at = Date.now();
  const { from, ...data } = l;
  await ensure(env, f, LOG, CREATE_LOG);
  await ch(env, f, `INSERT INTO ${LOG} FORMAT JSONEachRow`, JSON.stringify({
    fleet, machine, file: "tools", pos: at, n: Math.floor(Math.random() * 0xffffffff), at: at / 1000, part: "services", level: l.ok ? "info" : "warn", msg: "tool",
    session: from, account: "", status: 0, kind: "", text: "", data: JSON.stringify(data),
  }));
}

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
  await ensure(env, f, TABLE, CREATE);
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

const KEY: Record<string, string> = { day: "toString(toDate(c.at))", model: "c.model", machine: "c.machine", session: "c.callsign", person: "c.owner", project: "c.project", account: "a.name" };
/** Аккаунт вызова: строка вызова журнала машины с тем же номером запроса Claude. Имя колонки итога — не account: ClickHouse подставил бы его в WHERE вместо колонки таблицы.
 * Вызов без такой строки (провайдер, вызов до журнала) — с пустым аккаунтом. */
const ACCOUNTS = `LEFT JOIN (SELECT JSONExtractString(data, 'req') AS req, argMax(account, at) AS name FROM ${LOG} FINAL
        WHERE fleet = {fleet:String} AND msg = 'call' AND account != '' AND at >= parseDateTimeBestEffort({from:String}) - INTERVAL 1 DAY AND at < parseDateTimeBestEffort({to:String}) + INTERVAL 1 DAY
        GROUP BY req HAVING req != '') AS a ON a.req = c.req`;

export const analytics: Module = {
  name: NAME,
  handlers: {
    async "analytics.query"(i: { by: string; since: string; until: string; machine?: string }, ctx: Ctx) {
      if (!ctx.env.CH_URL) throw new Refusal("analytics_unavailable", "аналитика не подключена");
      if (i.machine && !canReach(ctx.who, i.machine)) throw new Refusal("forbidden", `до машины ${i.machine} вы не достаёте`);
      const machines = i.machine ? [i.machine] : ctx.who.machines;
      // разрез и модель: стоимость считается по модели, затем складывается по разрезу
      const query = `SELECT ${KEY[i.by]} AS key, c.model AS model, count() AS calls, sum(c.input) AS input, sum(c.output) AS output, sum(c.cache_read) AS cacheRead, sum(c.cache_write) AS cacheWrite
        FROM ${TABLE} AS c FINAL ${i.by === "account" ? ACCOUNTS : ""}
        WHERE c.fleet = {fleet:String} AND has({machines:Array(String)}, c.machine) AND c.at >= parseDateTimeBestEffort({from:String}) AND c.at < parseDateTimeBestEffort({to:String})
        GROUP BY key, model ORDER BY key FORMAT JSON`;
      let text: string;
      try {
        // на свежем ClickHouse таблицы нет, пока её не завела первая точка: чтение заводит её так же, как запись
        await ensure(ctx.env, ctx.fetch, TABLE, CREATE);
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
        await ensure(ctx.env, ctx.fetch, TABLE, CREATE);
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

    /** Пачка строк журнала машины — в ClickHouse внутри запроса: ответ после записи. Не принял — отказ словом, машина пришлёт пачку снова с того же места. */
    async "log.write"(i: { file: string; pos: number; lines: string[] }, ctx: Ctx) {
      if (!ctx.env.CH_URL) throw new Refusal("analytics_unavailable", "аналитика не подключена");
      const machine = machineOf(ctx.who.addr)!;
      const rows = i.lines.map((text, n) => logRow(ctx.fleet, machine, i.file, i.pos, n, text)).filter((r): r is string => r !== null);
      if (!rows.length) return {};
      try {
        await ensure(ctx.env, ctx.fetch, LOG, CREATE_LOG);
        await ch(ctx.env, ctx.fetch, `INSERT INTO ${LOG} FORMAT JSONEachRow`, rows.join("\n"));
      } catch (e) {
        throw new Refusal("analytics_unavailable", e instanceof Error ? e.message : String(e));
      }
      return {};
    },

    /** История флота: строки журналов машин, до которых человек достаёт, новые первыми. */
    async "log.query"(i: { msg?: string; machine?: string; session?: string; account?: string; level?: string; since?: number; before?: number; limit?: number }, ctx: Ctx) {
      if (!ctx.env.CH_URL) throw new Refusal("analytics_unavailable", "аналитика не подключена");
      if (i.machine && !canReach(ctx.who, i.machine)) throw new Refusal("forbidden", `до машины ${i.machine} вы не достаёте`);
      const limit = Math.min(i.limit ?? 100, 1000);
      const list = (items: string[]) => `[${items.map((m) => `'${m}'`).join(",")}]`;
      const where = ["fleet = {fleet:String}", "has({machines:Array(String)}, machine)"];
      const params: Record<string, string> = { fleet: ctx.fleet, machines: list(i.machine ? [i.machine] : ctx.who.machines), limit: String(limit + 1) };
      const add = (cond: string, name: string, value: string | undefined) => {
        if (value === undefined || value === "") return;
        where.push(cond);
        params[name] = value;
      };
      add("startsWith(msg, {msg:String})", "msg", i.msg);
      add("session = {session:String}", "session", i.session);
      add("account = {account:String}", "account", i.account);
      add("has({levels:Array(String)}, level)", "levels", i.level ? list(LEVELS[i.level]!) : undefined);
      add("at >= fromUnixTimestamp64Milli({since:Int64})", "since", i.since === undefined ? undefined : String(i.since));
      add("at < fromUnixTimestamp64Milli({before:Int64})", "before", i.before === undefined ? undefined : String(i.before));
      const query = `SELECT toUnixTimestamp64Milli(at) AS at, machine, part, level, msg, session, account, status, kind, text, data FROM ${LOG} FINAL
        WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT {limit:UInt32} FORMAT JSON`;
      let text: string;
      try {
        await ensure(ctx.env, ctx.fetch, LOG, CREATE_LOG);
        text = await ch(ctx.env, ctx.fetch, query, undefined, params);
      } catch (e) {
        throw new Refusal("analytics_unavailable", e instanceof Error ? e.message : String(e));
      }
      const data = (JSON.parse(text) as { data: Record<string, string | number>[] }).data;
      const lines: LogRow[] = data.slice(0, limit).map((r) => ({
        at: Number(r.at), machine: String(r.machine), part: String(r.part), level: String(r.level), msg: String(r.msg),
        ...(r.session ? { session: String(r.session) } : {}), ...(r.account ? { account: String(r.account) } : {}), ...(Number(r.status) ? { status: Number(r.status) } : {}),
        ...(r.kind ? { kind: String(r.kind) } : {}), ...(r.text ? { text: String(r.text) } : {}), ...(r.data ? { data: JSON.parse(String(r.data)) as unknown } : {}),
      }));
      return { lines, more: data.length > limit };
    },
  },
};
