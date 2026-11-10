import { describe, expect, it } from "vitest";
import { type ArchSession, type LedgerEvent, type SdkEvent, sha256hex } from "@sb/protocol";
import type { PointNote } from "../env.ts";
import { consume } from "./analytics/analytics.ts";
import { blockKey } from "./archive/archive.ts";
import { gzip } from "../r2.ts";
import { type Stand, stand } from "../../test/stand.ts";

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 };
const LINES = [
  { type: "user", uuid: "u1", timestamp: "2026-11-09T10:00:00Z", message: { role: "user", content: "выложи сайт" } },
  { type: "assistant", uuid: "a1", timestamp: "2026-11-09T10:00:05Z", message: { id: "msg_1", model: "claude-fable-5-2", usage, content: [{ type: "text", text: "Начинаю" }] } },
  { type: "assistant", uuid: "a2", timestamp: "2026-11-09T10:00:05Z", message: { id: "msg_1", model: "claude-fable-5-2", usage, content: [{ type: "tool_use", name: "Bash" }] } },
  { type: "user", uuid: "u2", timestamp: "2026-11-09T10:00:09Z", message: { role: "user", content: [{ type: "tool_result" }] } },
  { type: "assistant", uuid: "a3", timestamp: "2026-11-09T10:00:12Z", message: { id: "msg_2", model: "claude-fable-5-2", usage, content: [{ type: "text", text: "Готово" }] } },
];

/** Файл разговора двумя блоками и запрос точки. */
async function pointOf(sid: string, words: string, lines: object[] = LINES) {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const parts = [text.slice(0, 200), text.slice(200)];
  const hashes = await Promise.all(parts.map(sha256hex));
  const put = {
    sid, callsign: "site@laptop", point: "p1", title: "Выкладка", model: "claude-fable-5-2", cwd: "~/site", project: "site",
    files: [{ path: `projects/site/${sid}.jsonl`, blocks: hashes, size: text.length }],
    text: [{ uuid: sid + "-u1", role: "user", text: words }],
  };
  return { put, parts, hashes };
}

/** Сохранить точку от имени машины: загрузить недостающие блоки и записать. */
async function save(s: Stand, sid: string, words: string, as = "klaptop", point = "p1") {
  const p = await pointOf(sid, words);
  const first = (await s.ask("points.put", { ...p.put, point }, as)).result as { upload: Record<string, string>; done: boolean };
  const machine = s.whos.get(s.key(as))!.addr.slice(1);
  for (const [i, h] of p.hashes.entries()) if (first.upload[h]) await s.env.FILES.put(blockKey(s.fleet, machine, h), await gzip(p.parts[i]!));
  if (!first.done) expect(await s.ask("points.put", { ...p.put, point, commit: true }, as)).toMatchObject({ result: { done: true } });
  return p;
}

const list = async (s: Stand, f: Record<string, unknown>, as = "kyura1") => (await s.ask("points.list", f, as)).result as { sessions: ArchSession[]; points?: { point: string }[]; more: boolean };

describe("архив сессий", () => {
  it("точка в два шага: ссылки на недостающие блоки, затем запись; недогруженная точка не записывается", async () => {
    const s = stand();
    const p = await pointOf("sid1", "выкладка сайта");
    const first = (await s.ask("points.put", p.put, "klaptop")).result as { upload: Record<string, string>; done: boolean };
    expect(first.done).toBe(false);
    expect(Object.keys(first.upload).sort()).toEqual([...p.hashes].sort());
    expect(first.upload[p.hashes[0]!]).toContain(`/blocks/${s.fleet}/laptop/${p.hashes[0]}.gz?`);
    await s.env.FILES.put(blockKey(s.fleet, "laptop", p.hashes[0]!), await gzip(p.parts[0]!));
    expect(await s.ask("points.put", { ...p.put, commit: true }, "klaptop")).toMatchObject({ ok: false, error: "blocks_missing" });
    expect((await list(s, {})).sessions).toHaveLength(0);
    await s.env.FILES.put(blockKey(s.fleet, "laptop", p.hashes[1]!), await gzip(p.parts[1]!));
    expect(await s.ask("points.put", { ...p.put, commit: true }, "klaptop")).toMatchObject({ result: { done: true, upload: {} } });
    expect((await list(s, {})).sessions).toMatchObject([{ sid: "sid1", machine: "laptop", callsign: "site@laptop", title: "Выкладка", points: 1, project: "site" }]);
    // вторая точка с теми же блоками записывается сразу: загружать нечего
    expect(await s.ask("points.put", { ...p.put, point: "p2" }, "klaptop")).toMatchObject({ result: { done: true } });
    const one = await list(s, { sid: "sid1" });
    expect(one.sessions[0]!.points).toBe(2);
    expect(one.points!.map((x) => x.point).sort()).toEqual(["p1", "p2"]);
  });

  it("точку сохраняет только машина; блок с именем не хэша не принимается", async () => {
    const s = stand();
    const p = await pointOf("sid1", "x");
    expect(await s.ask("points.put", p.put, "kyura1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await s.ask("points.put", { ...p.put, files: [{ path: "a", blocks: ["не-хэш"], size: 1 }] }, "klaptop")).toMatchObject({ ok: false, error: "bad_input" });
  });

  it("поиск по словам идёт только по машинам, до которых человек достаёт", async () => {
    const s = stand();
    await save(s, "sid-yura", "выкладка сайта на прод", "klaptop");
    await save(s, "sid-oleg", "выкладка секретная", "kolegm");
    const found = async (as: string, f: Record<string, unknown> = {}) => (await list(s, { q: "выкладка", ...f }, as)).sessions.map((x) => [x.sid, x.machine]);
    expect(await found("kanya1")).toEqual([["sid-yura", "laptop"]]);
    expect(await found("koleg1")).toEqual([["sid-oleg", "oleg-mac"]]);
    expect((await found("kyura1")).sort()).toEqual([["sid-oleg", "oleg-mac"], ["sid-yura", "laptop"]]);
    expect((await list(s, { q: "выкладка" }, "kanya1")).sessions[0]!.hit).toContain("выкладка");
    expect((await list(s, { q: "прод секретная" }, "kyura1")).sessions).toHaveLength(0);
    expect(await s.ask("points.list", { machine: "oleg-mac" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
    // чужую сессию не открыть и по номеру
    expect(await s.ask("points.history", { sid: "sid-oleg" }, "kanya1")).toMatchObject({ ok: false, error: "not_found" });
  });

  it("разговор точки страницами с конца; ссылки на блоки; удаление точки и сессии", async () => {
    const s = stand();
    const p = await save(s, "sid1", "выкладка");
    const page = async (f: Record<string, unknown>) => (await s.ask("points.history", { sid: "sid1", ...f }, "kanya1")).result as { events: SdkEvent[]; more: boolean };
    const last = await page({ limit: 2 });
    expect(last.events.map((e) => e.uuid)).toEqual(["u2", "a3"]);
    expect(last.more).toBe(true);
    const prev = await page({ limit: 5, before: "u2" });
    expect(prev.events.map((e) => e.uuid)).toEqual(["u1", "a1", "a2"]);
    expect(prev.more).toBe(false);
    const got = (await s.ask("points.get", { sid: "sid1" })).result as { files: { path: string; blocks: { hash: string; url: string }[] }[]; point: { point: string } };
    expect(got.point.point).toBe("p1");
    expect(got.files[0]!.blocks.map((b) => b.hash)).toEqual(p.hashes);
    expect(got.files[0]!.blocks[0]!.url).toContain("X-Amz-Signature=");
    await save(s, "sid1", "выкладка", "klaptop", "p2");
    await s.ask("points.delete", { sid: "sid1", point: "p1" });
    expect((await list(s, { sid: "sid1" })).sessions[0]!.points).toBe(1);
    await s.ask("points.delete", { sid: "sid1" });
    expect((await list(s, {})).sessions).toHaveLength(0);
    expect((await list(s, { q: "выкладка" })).sessions).toHaveLength(0);
  });
});

/** Пачка очереди из одной записки. */
function batch(note: PointNote, attempts = 1) {
  const seen = { ack: 0, retry: 0 };
  const b = { queue: "sb2-analytics", messages: [{ id: "1", timestamp: new Date(), body: note, attempts, ack: () => void seen.ack++, retry: () => void seen.retry++ }], ackAll() {}, retryAll() {} };
  return { b: b as unknown as MessageBatch<PointNote>, seen };
}

/** Подделка ClickHouse: строки вставки складываются по ключу таблицы. */
function clickhouse(s: Stand) {
  const rows = new Map<string, Record<string, unknown>>();
  s.state.net = (url, init) => {
    const q = new URL(url).searchParams.get("query") ?? "";
    if (q.startsWith("INSERT")) for (const l of String(init?.body).split("\n")) {
      const r = JSON.parse(l);
      rows.set([r.fleet, r.machine, r.sid, r.call].join("|"), r);
    }
    if (q.startsWith("SELECT machine")) return Response.json({ data: [...new Set([...rows.values()].map((r) => r.machine))].map((machine) => ({ machine, rows: String(rows.size), last: String(Math.max(...[...rows.values()].map((r) => Number(r.at) * 1000))) })) });
    if (q.startsWith("SELECT")) return Response.json({ data: [{ key: "2026-11-09", calls: "2", input: "200", output: "40", cacheRead: "10", cacheWrite: "14" }] });
    return new Response("");
  };
  return rows;
}

describe("аналитика в стороне", () => {
  const CH = { CH_URL: "https://ch.test:8443/", CH_USER: "sb", CH_PASSWORD: "pw" };

  it("ClickHouse не подключён: точка сохранена, поиск работает, отчёт отвечает analytics_unavailable", async () => {
    const s = stand();
    await save(s, "sid1", "выкладка сайта");
    expect((await list(s, { q: "сайта" })).sessions).toHaveLength(1);
    expect(await s.ask("analytics.query", { by: "day", since: "2026-11-01", until: "2026-11-10" })).toMatchObject({ ok: false, error: "analytics_unavailable" });
  });

  it("точка даёт по строке на вызов модели; одна точка дважды — строк столько же", async () => {
    const s = stand(undefined, { env: CH });
    await save(s, "sid1", "выкладка");
    const rows = clickhouse(s);
    const note = { fleet: s.fleet, machine: "laptop", sid: "sid1", point: "p1" };
    const one = batch(note);
    await consume(one.b, s.env, s.deps);
    expect(one.seen).toEqual({ ack: 1, retry: 0 });
    expect([...rows.values()].map((r) => [r.call, r.model, r.input, r.output, r.cache_read, r.cache_write, r.owner, r.callsign, r.project]).sort()).toEqual([
      ["msg_1", "claude-fable-5-2", 100, 20, 5, 7, "~yuri@example.com", "site@laptop", "site"],
      ["msg_2", "claude-fable-5-2", 100, 20, 5, 7, "~yuri@example.com", "site@laptop", "site"],
    ]);
    await consume(batch(note).b, s.env, s.deps);
    expect(rows.size).toBe(2);
  });

  it("состояние аналитики: не подключена — on:false; точка не долита — pending 1; долита — строки и pending 0; ClickHouse лёг — ok:false с причиной", async () => {
    expect((await stand().ask("analytics.state", {})).result).toEqual({ on: false, ok: false, machines: [] });
    const s = stand(undefined, { env: CH });
    await save(s, "sid1", "выкладка");
    clickhouse(s);
    const state = async () => (await s.ask("analytics.state", {})).result as { ok: boolean; error?: string; machines: Array<{ machine: string; rows: number; pending: number; last?: number }> };
    expect((await state()).machines.find((m) => m.machine === "laptop")).toEqual({ machine: "laptop", rows: 0, pending: 1 });
    await consume(batch({ fleet: s.fleet, machine: "laptop", sid: "sid1", point: "p1" }).b, s.env, s.deps);
    expect((await state()).machines.find((m) => m.machine === "laptop")).toMatchObject({ rows: 2 });
    s.state.net = () => new Response("down", { status: 503 });
    expect(await state()).toMatchObject({ ok: false, error: expect.stringContaining("503"), machines: [] });
  });

  it("ClickHouse не отвечает: очередь повторяет, после повторов — одна строка в журнале флота; точка, разговор и поиск целы", async () => {
    const s = stand(undefined, { env: CH });
    await save(s, "sid1", "выкладка сайта");
    s.state.net = () => new Response("down", { status: 503 });
    const note = { fleet: s.fleet, machine: "laptop", sid: "sid1", point: "p1" };
    const first = batch(note, 1);
    await consume(first.b, s.env, s.deps);
    expect(first.seen).toEqual({ ack: 0, retry: 1 });
    const failed = async () => ((await s.ask("ledger.read", { what: "analytics." })).result as { events: LedgerEvent[] }).events;
    expect(await failed()).toHaveLength(0);
    const last = batch(note, 3);
    await consume(last.b, s.env, s.deps);
    expect(last.seen).toEqual({ ack: 1, retry: 0 });
    expect(await failed()).toMatchObject([{ what: "analytics.failed", machine: "laptop", data: { sid: "sid1", point: "p1" } }]);
    expect((await list(s, { q: "сайта" })).sessions).toHaveLength(1);
    expect(((await s.ask("points.history", { sid: "sid1" })).result as { events: unknown[] }).events).toHaveLength(5);
    expect(await s.ask("analytics.query", { by: "day", since: "2026-11-01", until: "2026-11-10" })).toMatchObject({ ok: false, error: "analytics_unavailable" });
  });

  it("отчёт видит только машины, до которых человек достаёт; доливка кладёт точки архива в очередь", async () => {
    const s = stand(undefined, { env: CH });
    clickhouse(s);
    const r = await s.ask("analytics.query", { by: "day", since: "2026-11-01", until: "2026-11-10" }, "kanya1");
    expect(r.result).toEqual({ rows: [{ key: "2026-11-09", calls: 2, input: 200, output: 40, cacheRead: 10, cacheWrite: 14 }] });
    const asked = new URL(s.seen.net.at(-1)!.url).searchParams;
    expect(asked.get("param_machines")).toBe("['anya-pc','laptop','server']");
    expect(asked.get("param_fleet")).toBe(s.fleet);
    expect(await s.ask("analytics.query", { by: "day", since: "2026-11-01", until: "2026-11-10", machine: "oleg-mac" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
    await save(s, "sid1", "a");
    await save(s, "sid2", "b", "kolegm");
    expect((await s.ask("analytics.fill", { since: 0 })).result).toEqual({ queued: 2 });
    expect(await s.ask("analytics.fill", { since: 0 }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("архив: документ сессии", () => {
  it("документ, с которым сессия сохранялась, отдаётся с точкой — с ним её поднимают", async () => {
    const s = await stand();
    const spec = { name: "site", cwd: "~/p", slot: "deepseek", pieces: ["base"], model: "m" };
    const p = await pointOf("s-spec", "документ");
    const first = (await s.ask("points.put", { ...p.put, spec }, "klaptop")).result as { upload: Record<string, string>; done: boolean };
    for (const [i, h] of p.hashes.entries()) if (first.upload[h]) await s.env.FILES.put(blockKey(s.fleet, "laptop", h), await gzip(p.parts[i]!));
    if (!first.done) expect(await s.ask("points.put", { ...p.put, spec, commit: true }, "klaptop")).toMatchObject({ result: { done: true } });
    const got = (await s.ask("points.get", { sid: "s-spec" }, "kyura1")).result as { session: { spec?: unknown } };
    expect(got.session.spec).toEqual(spec);
  });
});
