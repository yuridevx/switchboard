// Эталоны истории флота: журнал машин в ClickHouse — приём пачки, повтор пачки, чтение с отбором, расход по аккаунтам.
// Источник — дизайн «Аккаунты и модели»: слово пользователя 15 нояб. — «вся история и весь лог должен быть в ClickHouse».
import { describe, expect, it } from "vitest";
import type { LogRow } from "@sb/protocol";
import { callsOf } from "./archive/archive.ts";
import { type Stand, stand } from "../../test/stand.ts";

const CH = { CH_URL: "https://ch.test:8443/", CH_USER: "sb", CH_PASSWORD: "pw" };
type Row = Record<string, string | number>;

/** Подделка ClickHouse для таблицы истории: строки вставки складываются по ключу таблицы; чтение применяет отбор из параметров запроса, как сам запрос. */
function clickhouse(s: Stand) {
  const rows = new Map<string, Row>();
  const queries: string[] = [];
  s.state.net = (url, init) => {
    const p = new URL(url).searchParams;
    const q = p.get("query") ?? "";
    queries.push(q);
    if (q.startsWith("INSERT INTO sb2_log")) for (const l of String(init?.body).split("\n")) {
      const r = JSON.parse(l) as Row;
      rows.set([r.fleet, r.machine, r.file, r.pos, r.n].join("|"), r);
    }
    if (!q.startsWith("SELECT")) return new Response("");
    const list = (name: string) => (p.get(name) ?? "[]").slice(1, -1).split(",").map((x) => x.slice(1, -1));
    const fits = (r: Row) =>
      r.fleet === p.get("param_fleet") && list("param_machines").includes(String(r.machine)) &&
      (!q.includes("startsWith(msg") || String(r.msg).startsWith(p.get("param_msg")!)) && (!q.includes("session = ") || r.session === p.get("param_session")) &&
      (!q.includes("account = ") || r.account === p.get("param_account")) && (!q.includes("{levels:") || list("param_levels").includes(String(r.level))) &&
      (!q.includes("{since:") || Number(r.at) * 1000 >= Number(p.get("param_since"))) && (!q.includes("{before:") || Number(r.at) * 1000 < Number(p.get("param_before")));
    const data = [...rows.values()].filter(fits).sort((a, b) => Number(b.at) - Number(a.at)).slice(0, Number(p.get("param_limit")))
      .map((r) => ({ ...r, at: String(Math.round(Number(r.at) * 1000)) }));
    return Response.json({ data });
  };
  return { rows, queries };
}

const T = Date.UTC(2026, 10, 15, 12, 0, 0);
const line = (t: number, msg: string, fields: Record<string, unknown> = {}) => JSON.stringify({ t, level: "info", part: "host", msg, machine: "чужая", fleet: "чужой", ...fields });
const write = (s: Stand, lines: string[], pos = 0, as = "klaptop", file = "host-2026-11-15.jsonl") => s.ask("log.write", { file, pos, lines }, as);
const read = async (s: Stand, f: Record<string, unknown>, as = "kyura1") => (await s.ask("log.query", f, as)).result as { lines: LogRow[]; more: boolean };

describe("история флота: журнал машин в ClickHouse", () => {
  // эталон: «Одна и та же пачка строк отправлена дважды» — чьё: код, так устроена аналитика точек
  it("пачка дважды — строк столько же; ключ строки — машина из пропуска, файл, начало пачки и номер строки", async () => {
    const s = stand(undefined, { env: CH });
    const { rows } = clickhouse(s);
    const lines = [
      line(T, "call", { callsign: "site@laptop", account: "a@example.com", status: 200, model: "claude-fable-5-2", req: "req_1", ms: 840, hops: 0 }),
      line(T + 1, "call", { callsign: "site@laptop", account: "a@example.com", status: 429, kind: "week", req: "req_2", why: "неделя выбрана" }),
      "{недописанная стро",
      line(T + 2, "route", { callsign: "site@laptop", account: "b@example.com", candidates: [{ account: "b@example.com", score: 0.43 }] }),
    ];
    expect((await write(s, lines, 4096)).ok).toBe(true);
    expect(rows.size).toBe(3);
    expect((await write(s, lines, 4096)).ok).toBe(true);
    expect(rows.size).toBe(3);
    // следующая пачка того же файла — новые строки
    expect((await write(s, [line(T + 3, "account.moved", { account: "b@example.com" })], 8192)).ok).toBe(true);
    expect(rows.size).toBe(4);
    const refused = rows.get([s.fleet, "laptop", "host-2026-11-15.jsonl", 4096, 1].join("|"))!;
    // машина и флот — из пропуска, а не из строки; у полей строки свои колонки, остальное — в data
    expect(refused).toEqual({
      fleet: s.fleet, machine: "laptop", file: "host-2026-11-15.jsonl", pos: 4096, n: 1, at: (T + 1) / 1000, part: "host", level: "info", msg: "call",
      session: "site@laptop", account: "a@example.com", status: 429, kind: "week", text: "неделя выбрана", data: JSON.stringify({ req: "req_2" }),
    });
    // пишет только машина
    expect(await write(s, lines, 0, "kyura1")).toMatchObject({ ok: false, error: "forbidden" });
  });

  // эталон: «ClickHouse недоступен час; сессии работают» — половина службы: отказ словом, очереди у службы нет — строки ждут в файле машины
  it("ClickHouse не принял пачку — машине отказ словом и ничего не записано; принял — те же строки на месте", async () => {
    const s = stand(undefined, { env: CH });
    const lines = [line(T, "call", { account: "a@example.com", status: 200 })];
    s.state.net = () => new Response("down", { status: 503 });
    expect(await write(s, lines)).toMatchObject({ ok: false, error: "analytics_unavailable", why: expect.stringContaining("503") });
    const { rows } = clickhouse(s);
    expect((await write(s, lines)).ok).toBe(true);
    expect(rows.size).toBe(1);
    expect(await stand().ask("log.write", { file: "host-2026-11-15.jsonl", pos: 0, lines }, "klaptop")).toMatchObject({ ok: false, error: "analytics_unavailable" });
    expect(await stand().ask("log.query", {})).toMatchObject({ ok: false, error: "analytics_unavailable" });
  });

  // эталон: «чтение с отбором „account.“ и одним аккаунтом» — чьё: слово пользователя 15 нояб. — «вся история и весь лог в ClickHouse»
  it("чтение с отбором «account.» и одним аккаунтом — только решения и события этого аккаунта, новые первыми", async () => {
    const s = stand(undefined, { env: CH });
    clickhouse(s);
    await write(s, [
      line(T, "call", { callsign: "site@laptop", account: "a@example.com", status: 200 }),
      line(T + 1000, "account.closed", { account: "a@example.com", kind: "week", why: "неделя выбрана до 18:00" }),
      line(T + 2000, "account.moved", { callsign: "site@laptop", account: "b@example.com", why: "a@example.com → b@example.com: неделя выбрана" }),
      line(T + 3000, "account.full", { level: "warn", account: "a@example.com", inflight: 16 }),
      line(T + 4000, "route", { callsign: "docs@laptop", account: "a@example.com", candidates: [{ account: "a@example.com", score: 0.98 }, { account: "b@example.com", score: 0.43 }] }),
    ]);
    await write(s, [line(T + 5000, "account.token", { level: "error", account: "a@example.com", why: "Claude ответил 401" })], 0, "kolegm");
    const got = await read(s, { msg: "account.", account: "a@example.com" });
    expect(got.lines.map((l) => [l.msg, l.machine])).toEqual([["account.token", "oleg-mac"], ["account.full", "laptop"], ["account.closed", "laptop"]]);
    expect(got.lines[1]).toEqual({ at: T + 3000, machine: "laptop", part: "host", level: "warn", msg: "account.full", account: "a@example.com", data: { inflight: 16 } });
    expect(got.lines[2]).toEqual({ at: T + 1000, machine: "laptop", part: "host", level: "info", msg: "account.closed", account: "a@example.com", kind: "week", text: "неделя выбрана до 18:00" });
    expect(got.more).toBe(false);
    // решение со счётом кандидатов — строкой route; отбор по сессии, уровню и времени
    expect((await read(s, { msg: "route" })).lines[0]).toMatchObject({ session: "docs@laptop", account: "a@example.com", data: { candidates: [{ account: "a@example.com", score: 0.98 }, { account: "b@example.com", score: 0.43 }] } });
    expect((await read(s, { session: "site@laptop" })).lines.map((l) => l.msg)).toEqual(["account.moved", "call"]);
    expect((await read(s, { level: "warn" })).lines.map((l) => l.msg)).toEqual(["account.token", "account.full"]);
    expect((await read(s, { since: T + 2000, before: T + 4000 })).lines.map((l) => l.msg)).toEqual(["account.full", "account.moved"]);
    expect(await read(s, { limit: 2 })).toMatchObject({ lines: [{ msg: "account.token" }, { msg: "route" }], more: true });
    // человек видит строки только тех машин, до которых достаёт
    expect((await read(s, {}, "kanya1")).lines.map((l) => l.machine)).not.toContain("oleg-mac");
    expect((await read(s, {}, "koleg1")).lines.map((l) => l.msg)).toEqual(["account.token"]);
    expect(await s.ask("log.query", { machine: "oleg-mac" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
  });

  // дизайн: расход по аккаунтам — соединение вызова из разговора со строкой вызова журнала по номеру запроса Claude
  it("расход по аккаунтам: вызов несёт номер запроса Claude, запрос соединяет его со строкой вызова журнала", async () => {
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 };
    const calls = callsOf([
      { type: "assistant", uuid: "a1", requestId: "req_011", timestamp: "2026-11-15T10:00:05Z", message: { id: "msg_1", model: "claude-fable-5-2", usage } },
      { type: "assistant", uuid: "a2", timestamp: "2026-11-15T10:00:09Z", message: { id: "msg_2", model: "claude-fable-5-2", usage } },
    ]);
    expect(calls.map((c) => [c.call, c.req])).toEqual([["msg_1", "req_011"], ["msg_2", ""]]);
    const s = stand(undefined, { env: CH });
    let asked = "";
    s.state.net = (url) => {
      asked = new URL(url).searchParams.get("query") ?? "";
      return Response.json({ data: [
        { key: "a@example.com", model: "claude-fable-5-2", calls: "2", input: "200", output: "40", cacheRead: "10", cacheWrite: "14" },
        { key: "", model: "glm-5.3", calls: "1", input: "50", output: "5", cacheRead: "0", cacheWrite: "0" },
      ] });
    };
    const r = (await s.ask("analytics.query", { by: "account", since: "2026-11-01", until: "2026-11-16" })).result as { rows: { key: string; calls: number }[] };
    expect(r.rows).toEqual([{ key: "a@example.com", calls: 2, input: 200, output: 40, cacheRead: 10, cacheWrite: 14 }, { key: "", calls: 1, input: 50, output: 5, cacheRead: 0, cacheWrite: 0 }]);
    expect(asked).toContain("a.name AS key");
    expect(asked).toMatch(/LEFT JOIN \(SELECT JSONExtractString\(data, 'req'\) AS req, argMax\(account, at\) AS name FROM sb2_log FINAL[\s\S]*msg = 'call'[\s\S]*HAVING req != ''\) AS a ON a\.req = c\.req/);
    // прочие разрезы журнал не читают
    await s.ask("analytics.query", { by: "day", since: "2026-11-01", until: "2026-11-16" });
    expect(asked).not.toContain("sb2_log");
  });
});
