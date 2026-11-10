// Эталоны служб, вторая волна: сервер MCP и вход OAuth, ключи флота, журнал вперёд, архив (уборка блоков, срок точек, страницы разговора,
// вызовы модели, хозяин), стоимость расхода, наблюдение (сводка здоровья, оповещения). Источник — дизайн «Switchboard с нуля» и сверка функций старой системы.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArchPoint, type ArchSession, type KeyRow, type LedgerEvent, type ModelCall, type ObsRow, type SdkEvent, type SessionRow, sha256hex } from "@sb/protocol";
import type { Env, PointNote } from "../env.ts";
import { consume } from "./analytics/analytics.ts";
import { blockKey, costOf, expiries } from "./archive/archive.ts";
import { gzip } from "../r2.ts";
import { b64u } from "./reach/webpush.ts";
import { type Stand, stand } from "../../test/stand.ts";

const DAY = 86_400_000;
afterEach(() => vi.useRealTimers());

/* ===== Сервер MCP и вход OAuth ===== */

async function mcp(s: Stand, body: unknown, as: string | null = "kanya1", headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (as) h.authorization = "Bearer " + s.key(as);
  const res = await s.http("/mcp", { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: res.headers.get("content-type")?.includes("json") ? ((await res.json()) as any) : null };
}

describe("сервер MCP: внешний клиент", () => {
  it("без пропуска — 401 со ссылкой на метаданные входа; метаданные называют сервер входа, согласие и /token", async () => {
    const s = stand();
    const no = await mcp(s, { jsonrpc: "2.0", id: 1, method: "initialize" }, null);
    expect(no.status).toBe(401);
    expect(no.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://fleet.test/.well-known/oauth-protected-resource"');
    expect(no.headers.get("access-control-expose-headers")).toContain("www-authenticate");
    // неживой пропуск — то же
    expect((await mcp(s, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "knobody")).headers.get("www-authenticate")).toContain("resource_metadata");
    expect(await (await s.http("/.well-known/oauth-protected-resource")).json()).toEqual({ resource: "https://fleet.test/mcp", authorization_servers: ["https://fleet.test"], bearer_methods_supported: ["header"] });
    expect(await (await s.http("/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject({ resource: "https://fleet.test/mcp" });
    expect(await (await s.http("/.well-known/oauth-authorization-server")).json()).toMatchObject({
      issuer: "https://fleet.test", authorization_endpoint: "https://fleet.test/consent", token_endpoint: "https://fleet.test/token",
      code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true,
    });
  });

  it("/token меняет код согласия на пропуск: приём приглашения с проверочным словом у объекта флота", async () => {
    const s = stand();
    s.state.fleetAnswer = (f) => (f.verifier === "good" ? { type: "reply", id: f.id!, ok: true, result: { key: "home:kid123:" + "x".repeat(20), addr: "claude-ab12~anya@example.com" } } : { type: "reply", id: f.id!, ok: false, error: "bad_invite" });
    const form = (o: Record<string, string>) => s.http("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
    const full = { grant_type: "authorization_code", code: `${s.fleet}:kinvite1:${"s".repeat(20)}`, code_verifier: "good", client_id: "https://c.example/c.json", redirect_uri: "https://c.example/cb" };
    const ok = await form(full);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ access_token: "home:kid123:" + "x".repeat(20), token_type: "Bearer" });
    expect(s.seen.fleetCalls.at(-1)).toMatchObject({ who: null, frame: { type: "redeem", invite: full.code, verifier: "good", client: full.client_id, back: full.redirect_uri } });
    const bad = await form({ ...full, code_verifier: "wrong" });
    expect([bad.status, await bad.json()]).toMatchObject([400, { error: "invalid_grant" }]);
    expect(await (await form({ ...full, grant_type: "password" })).json()).toMatchObject({ error: "unsupported_grant_type" });
    expect(await (await form({ grant_type: "authorization_code", code: full.code })).json()).toMatchObject({ error: "invalid_request" });
  });

  it("пачка сообщений — пачка ответов; уведомления ответа не дают; пропуск сверяется один раз", async () => {
    const s = stand();
    let whos = 0;
    const who = s.platform.who;
    s.platform.who = (k, as) => (whos++, who(k, as));
    const r = await mcp(s, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ]);
    expect(r.body.map((x: any) => x.id)).toEqual([1, 2, 3]);
    expect(r.body[0].result.protocolVersion).toBe("2025-03-26");
    expect(whos).toBe(1);
    expect((await mcp(s, [{ jsonrpc: "2.0", method: "notifications/initialized" }])).status).toBe(202);
  });

  it("версия протокола: знакомая — как просили, незнакомая — последняя; тело больше 1 МБ — 413; предзапрос браузера — 204", async () => {
    const s = stand();
    const v = async (protocolVersion: string) => (await mcp(s, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } })).body.result.protocolVersion;
    expect(await v("2024-11-05")).toBe("2024-11-05");
    expect(await v("2099-01-01")).toBe("2025-06-18");
    const big = await mcp(s, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } }));
    expect(big.status).toBe(413);
    const pre = await s.http("/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai" } });
    expect([pre.status, pre.headers.get("access-control-allow-origin"), pre.headers.get("access-control-allow-headers")]).toMatchObject([204, "*", expect.stringContaining("authorization")]);
    expect((await mcp(s, { jsonrpc: "2.0", id: 1, method: "ping" })).headers.get("access-control-allow-origin")).toBe("*");
  });

  it("ключи флота — инструменты: список без значений, запись — только админу", async () => {
    const s = stand();
    const names = ((await mcp(s, { jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["keys_list", "keys_set", "fleet_list", "obs_health", "points_calls"]));
    expect(names).not.toContain("keys_value");
    const call = (name: string, args: object, as = "kyura1") => mcp(s, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, as);
    expect((await call("keys_set", { name: "deepseek", provider: "anthropic", value: "sk-secret-1234" }, "kanya1")).body.result.isError).toBe(true);
    expect((await call("keys_set", { name: "deepseek", provider: "anthropic", value: "sk-secret-1234" })).body.result.isError).toBe(false);
    const text = (await call("keys_list", {}, "kanya1")).body.result.content[0].text as string;
    expect(JSON.parse(text).keys).toMatchObject([{ name: "deepseek", tail: "1234" }]);
    expect(text).not.toContain("sk-secret");
  });
});

/* ===== Ключи флота ===== */

describe("ключи флота: свойства и сессии", () => {
  const list = async (s: Stand) => ((await s.ask("keys.list")).result as { keys: KeyRow[] }).keys;

  it("соответствие моделей, окно, настройки и окружение хранятся с ключом и отдаются машине; значение при правке свойств не нужно", async () => {
    const s = stand();
    await s.ask("keys.set", { name: "orca", provider: "anthropic", value: "sk-orca-9999", base: "https://api.orca.example", model: "orca/flash", models: { "claude-fable-5-2": "orca/flash" }, window: 128000 });
    expect(await list(s)).toMatchObject([{ name: "orca", base: "https://api.orca.example", model: "orca/flash", models: { "claude-fable-5-2": "orca/flash" }, window: 128000, tail: "9999", sessions: 0 }]);
    // правка свойств без значения: значение прежнее, прежние свойства целы
    expect((await s.ask("keys.set", { name: "orca", provider: "anthropic", base: "https://api.orca.example", model: "orca/flash", env: { ORCA_REGION: "eu" }, settings: { alwaysThinkingEnabled: false } })).ok).toBe(true);
    expect((await s.ask("keys.value", { name: "orca" }, "klaptop")).result).toEqual({
      value: "sk-orca-9999", provider: "anthropic", base: "https://api.orca.example", model: "orca/flash",
      models: { "claude-fable-5-2": "orca/flash" }, window: 128000, env: { ORCA_REGION: "eu" }, settings: { alwaysThinkingEnabled: false },
    });
    expect(s.seen.broadcasts.filter((b) => b.frame.what === "keys")).toHaveLength(2);
    expect(await s.ask("keys.set", { name: "new", provider: "anthropic" })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("число сессий на ключе — по картине; проба удаления называет сессии и ничего не удаляет", async () => {
    const s = stand();
    await s.ask("keys.set", { name: "orca", provider: "anthropic", value: "sk-orca-9999" });
    const row = (callsign: string, extra: Partial<SessionRow>): SessionRow => ({ callsign, state: "idle", spec: { name: callsign.split("@")[0]!, cwd: "~" }, by: "~yuri@example.com", since: 1, ...extra });
    s.state.sessions = [row("a@laptop", { account: "orca" }), row("b@server", { spec: { name: "b", cwd: "~", slot: "orca" } }), row("c@laptop", { account: "yuri@example.com" })];
    expect((await list(s))[0]!.sessions).toBe(2);
    expect((await s.ask("keys.remove", { name: "orca", probe: true })).result).toEqual({ sessions: ["a@laptop", "b@server"] });
    expect(await list(s)).toHaveLength(1);
    expect((await s.ask("keys.remove", { name: "orca" })).ok).toBe(true);
    expect(await list(s)).toHaveLength(0);
  });
});

/* ===== Журнал флота ===== */

describe("журнал флота: чтение вперёд", () => {
  it("after отдаёт только события новее, от старых к новым", async () => {
    const s = stand();
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [t, what] of [[1000, "a"], [2000, "b"], [3000, "c"]] as const) {
      vi.setSystemTime(t);
      await s.ask("ledger.add", { what }, "klaptop");
    }
    const read = async (f: Record<string, unknown>) => ((await s.ask("ledger.read", f)).result as { events: LedgerEvent[]; more: boolean });
    expect((await read({})).events.map((e) => e.what)).toEqual(["c", "b", "a"]);
    expect((await read({ after: 1000 })).events.map((e) => e.what)).toEqual(["b", "c"]);
    expect(await read({ after: 3000 })).toEqual({ events: [], more: false });
    expect(await read({ after: 0, limit: 2 })).toMatchObject({ events: [{ what: "a" }, { what: "b" }], more: true });
  });
});

/* ===== Архив ===== */

type Put = { sid: string; point: string; lines?: object[]; chunk?: number; words?: string; tokens?: number; callsign?: string };

/** Сохранить точку: файл разговора режется на блоки по chunk знаков; недостающие блоки загружаются. */
async function save(s: Stand, p: Put, as = "klaptop") {
  const machine = s.whos.get(s.key(as))!.addr.slice(1);
  const text = (p.lines ?? [{ type: "user", uuid: p.sid + "-" + p.point, message: { role: "user", content: p.point } }]).map((l) => JSON.stringify(l)).join("\n") + "\n";
  const size = p.chunk ?? 200;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  const hashes = await Promise.all(parts.map(sha256hex));
  const put = {
    sid: p.sid, callsign: p.callsign ?? "site@" + machine, point: p.point, title: "Сессия " + p.sid, model: "claude-fable-5-2", ...(p.tokens !== undefined ? { tokens: p.tokens } : {}),
    files: [{ path: `projects/x/${p.sid}.jsonl`, blocks: hashes, size: text.length }],
    ...(p.words ? { text: [{ uuid: `${p.sid}-${p.point}-w`, role: "user", text: p.words }] } : {}),
  };
  const first = (await s.ask("points.put", put, as)).result as { upload: Record<string, string>; done: boolean };
  for (const [i, h] of hashes.entries()) if (first.upload[h]) await s.env.FILES.put(blockKey(s.fleet, machine, h), await gzip(parts[i]!));
  if (!first.done) expect(await s.ask("points.put", { ...put, commit: true }, as)).toMatchObject({ result: { done: true } });
  return { hashes, machine };
}
const has = async (s: Stand, machine: string, hash: string) => !!(await s.env.FILES.head(blockKey(s.fleet, machine, hash)));
const list = async (s: Stand, f: Record<string, unknown> = {}, as = "kyura1") => (await s.ask("points.list", f, as)).result as { sessions: ArchSession[]; points?: ArchPoint[]; more: boolean };

describe("архив: уборка блоков", () => {
  it("удалённая точка уносит свои блоки; блок, на который ссылается другая точка, остаётся", async () => {
    const s = stand();
    const shared = { type: "user", uuid: "u0", message: { role: "user", content: "общее начало разговора ".repeat(12) } };
    const a = await save(s, { sid: "s1", point: "p1", lines: [shared] });
    const b = await save(s, { sid: "s1", point: "p2", lines: [shared, { type: "assistant", uuid: "a1", message: { content: "продолжение ".repeat(30) } }] });
    const common = a.hashes.filter((h) => b.hashes.includes(h)), onlyB = b.hashes.filter((h) => !a.hashes.includes(h)), onlyA = a.hashes.filter((h) => !b.hashes.includes(h));
    expect(common.length).toBeGreaterThan(0);
    expect(onlyB.length).toBeGreaterThan(0);
    expect((await s.ask("points.delete", { sid: "s1", point: "p2" })).ok).toBe(true);
    for (const h of onlyB) expect(await has(s, "laptop", h)).toBe(false);
    for (const h of [...common, ...onlyA]) expect(await has(s, "laptop", h)).toBe(true);
    expect((await list(s, { sid: "s1" })).points!.map((p) => p.point)).toEqual(["p1"]);
    // удаление сессии уносит остальное
    expect((await s.ask("points.delete", { sid: "s1" })).ok).toBe(true);
    for (const h of a.hashes) expect(await has(s, "laptop", h)).toBe(false);
    expect((await list(s)).sessions).toHaveLength(0);
  });

  it("у каждой машины свои блоки: удаление сессии одной машины не трогает такую же сессию другой", async () => {
    const s = stand();
    const lines = [{ type: "user", uuid: "u0", message: { role: "user", content: "одинаковый разговор" } }];
    const a = await save(s, { sid: "s1", point: "p1", lines }, "klaptop");
    const b = await save(s, { sid: "s2", point: "p1", lines }, "kolegm");
    expect(a.hashes).toEqual(b.hashes);
    await s.ask("points.delete", { sid: "s1" });
    expect(await has(s, "laptop", a.hashes[0]!)).toBe(false);
    expect(await has(s, "oleg-mac", b.hashes[0]!)).toBe(true);
  });
});

describe("архив: срок точек", () => {
  it("правило: последняя точка — без срока; последняя в неделе — год, последняя в дне — 30 дней, прочие — два дня", () => {
    const d = (day: number, hour: number) => day * DAY + hour * 3600_000;
    // день 0 — четверг: дни 0–3 — одна неделя, день 4 — понедельник следующей
    const until = expiries([{ point: "a", at: d(0, 10) }, { point: "b", at: d(0, 18) }, { point: "c", at: d(3, 9) }, { point: "d", at: d(4, 9) }, { point: "e", at: d(4, 20) }]);
    expect(until.get("a")).toBe(d(0, 0) + 2 * DAY);
    expect(until.get("b")).toBe(d(0, 0) + 30 * DAY);
    expect(until.get("c")).toBe(d(3, 0) + 365 * DAY);
    expect(until.get("d")).toBe(d(4, 0) + 2 * DAY);
    expect(until.get("e")).toBeNull();
  });

  it("новая точка прореживает линию сессии: точка с вышедшим сроком и её блоки убраны, остальные целы, срок виден в списке", async () => {
    const s = stand();
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 20_000 * DAY;
    const at = async (ms: number, point: string) => {
      vi.setSystemTime(t0 + ms);
      return save(s, { sid: "s1", point, lines: [{ type: "user", uuid: point, message: { role: "user", content: "точка " + point } }] });
    };
    const p1 = await at(10 * 3600_000, "p1");
    const p2 = await at(18 * 3600_000, "p2");
    // прошло пять дней: у p1 срок два дня — вышел; p2 — последняя точка своего дня — живёт
    const p3 = await at(5 * DAY, "p3");
    const pts = (await list(s, { sid: "s1" })).points!;
    expect(pts.map((p) => p.point)).toEqual(["p3", "p2"]);
    expect(pts.find((p) => p.point === "p3")!.until).toBeUndefined();
    expect(pts.find((p) => p.point === "p2")!.until).toBeGreaterThan(t0 + 5 * DAY);
    expect(await has(s, "laptop", p1.hashes[0]!)).toBe(false);
    expect(await has(s, "laptop", p2.hashes[0]!)).toBe(true);
    expect(await has(s, "laptop", p3.hashes[0]!)).toBe(true);
    expect((await list(s)).sessions[0]!.points).toBe(2);
  });
});

describe("архив: каталог, страницы разговора, вызовы модели, хозяин", () => {
  it("каталог: не старше since, порядок по токенам, пометка «идёт сейчас», владелец машины", async () => {
    const s = stand();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    await save(s, { sid: "old", point: "p1", tokens: 900, callsign: "old@laptop" });
    vi.setSystemTime(2_000_000);
    await save(s, { sid: "mid", point: "p1", tokens: 100, callsign: "mid@laptop" });
    vi.setSystemTime(3_000_000);
    await save(s, { sid: "new", point: "p1", tokens: 500, callsign: "new@laptop", words: "выкладка" });
    s.state.sessions = [{ callsign: "new@laptop", state: "busy", spec: { name: "new", cwd: "~" }, by: "~yuri@example.com", since: 1 }, { callsign: "old@laptop", state: "stopped", spec: { name: "old", cwd: "~" }, by: "~yuri@example.com", since: 1 }];
    expect((await list(s)).sessions.map((x) => x.sid)).toEqual(["new", "mid", "old"]);
    expect((await list(s, { since: 2_000_000 })).sessions.map((x) => x.sid)).toEqual(["new", "mid"]);
    expect((await list(s, { order: "tokens" })).sessions.map((x) => x.sid)).toEqual(["old", "new", "mid"]);
    const all = (await list(s)).sessions;
    // идёт сейчас — только та, что есть на машине и не остановлена
    expect(all.map((x) => [x.sid, !!x.live])).toEqual([["new", true], ["mid", false], ["old", false]]);
    expect(all[0]!.owner).toBe("~yuri@example.com");
    expect((await list(s, { q: "выкладка", since: 2_500_000 })).sessions).toMatchObject([{ sid: "new", live: true }]);
    expect((await list(s, { q: "выкладка", since: 3_500_000 })).sessions).toEqual([]);
  });

  it("страница разговора с конца читает только последние блоки файла; «раньше» идёт по uuid; ответ называет точку", async () => {
    let gets = 0;
    const base = stand();
    const files = new Proxy(base.env.FILES, { get: (t, k) => (k === "get" ? (...a: [string]) => (gets++, t.get(...a)) : Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k)) });
    const s = stand(base.fleet, { env: { FILES: files } as Partial<Env> });
    const lines = Array.from({ length: 200 }, (_, i) => ({ type: i % 2 ? "assistant" : "user", uuid: "m" + i, message: { content: "сообщение номер " + i + " " + "я".repeat(40) } }));
    const { hashes } = await save(s, { sid: "long", point: "p7", lines, chunk: 1000 });
    expect(hashes.length).toBeGreaterThan(15);
    gets = 0;
    const last = (await s.ask("points.history", { sid: "long", limit: 10 })).result as { events: SdkEvent[]; more: boolean; point: string };
    expect(last.events.map((e) => e.uuid)).toEqual(lines.slice(-10).map((l) => l.uuid));
    expect(last).toMatchObject({ more: true, point: "p7" });
    // 10 строк по ~110 знаков — в двух-трёх блоках по 1000 знаков, а не во всех
    expect(gets).toBeLessThan(hashes.length / 2);
    const prev = (await s.ask("points.history", { sid: "long", limit: 10, before: last.events[0]!.uuid })).result as { events: SdkEvent[]; more: boolean };
    expect(prev.events.map((e) => e.uuid)).toEqual(lines.slice(-20, -10).map((l) => l.uuid));
    // дочитали до начала
    const first = (await s.ask("points.history", { sid: "long", limit: 200, before: "m5" })).result as { events: SdkEvent[]; more: boolean };
    expect(first.events.map((e) => e.uuid)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(first.more).toBe(false);
  });

  it("вызовы модели у точки: один вызов на ответ модели, стоимость — по таблице цен флота", async () => {
    const s = stand();
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 };
    const lines = [
      { type: "user", uuid: "u1", message: { role: "user", content: "выложи" } },
      { type: "assistant", uuid: "a1", timestamp: "2026-11-09T10:00:05Z", message: { id: "msg_1", model: "claude-fable-5-2", usage, content: [] } },
      { type: "assistant", uuid: "a2", timestamp: "2026-11-09T10:00:05Z", message: { id: "msg_1", model: "claude-fable-5-2", usage, content: [] } },
      { type: "assistant", uuid: "a3", timestamp: "2026-11-09T10:00:12Z", message: { id: "msg_2", model: "orca/flash", usage, content: [] } },
    ];
    await save(s, { sid: "s1", point: "p1", lines });
    const calls = async () => ((await s.ask("points.calls", { sid: "s1" })).result as { point: string; calls: ModelCall[] }).calls;
    expect((await calls()).map((c) => [c.call, c.model, c.input, c.cost])).toEqual([["msg_1", "claude-fable-5-2", 1000, undefined], ["msg_2", "orca/flash", 1000, undefined]]);
    await s.ask("prefs.set", { scope: "fleet", name: "prices", value: { "claude-fable": { input: 5, output: 25, cacheRead: 0.5 } } });
    const priced = await calls();
    // 1000·5 + 200·25 + 5000·0,5 = 12 500 на миллион
    expect(priced[0]!.cost).toBeCloseTo(0.0125, 6);
    expect(priced[1]!.cost).toBeUndefined();
    expect(costOf({ "claude-": { input: 1 }, "claude-fable": { input: 5 } }, "claude-fable-5-2", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(5);
  });

  it("удаляет хозяин сессии — владелец её машины — и админ; ожидаемая последняя точка сверяется", async () => {
    const s = stand();
    await save(s, { sid: "s1", point: "p1" });
    await save(s, { sid: "s1", point: "p2" });
    // Аня достаёт до laptop, но машина Юры
    expect(await s.ask("points.delete", { sid: "s1" }, "kanya1")).toMatchObject({ ok: false, error: "not_owner" });
    expect(await s.ask("points.delete", { sid: "s1", expect: "p1" })).toMatchObject({ ok: false, error: "changed" });
    expect(await s.ask("points.delete", { sid: "s1", point: "nope" })).toMatchObject({ ok: false, error: "not_found" });
    expect((await s.ask("points.delete", { sid: "s1", expect: "p2" })).ok).toBe(true);
    // владелец своей машины удаляет без прав админа
    await save(s, { sid: "s2", point: "p1" }, "kolegm");
    expect((await s.ask("points.delete", { sid: "s2" }, "koleg1")).ok).toBe(true);
  });
});

/* ===== Расход ===== */

describe("расход: стоимость", () => {
  it("стоимость считается по моделям и складывается по разрезу; модель без цены в стоимость не входит", async () => {
    const s = stand(undefined, { env: { CH_URL: "https://ch.example" } });
    s.state.net = () =>
      Response.json({ data: [
        { key: "2026-11-09", model: "claude-fable-5-2", calls: 2, input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
        { key: "2026-11-09", model: "orca/flash", calls: 1, input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        { key: "2026-11-10", model: "orca/flash", calls: 3, input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      ] });
    await s.ask("prefs.set", { scope: "fleet", name: "prices", value: { "claude-fable": { input: 5, output: 25 } } });
    const r = (await s.ask("analytics.query", { by: "day", since: "2026-11-01", until: "2026-11-11" })).result as { rows: { key: string; calls: number; input: number; cost?: number }[] };
    expect(r.rows).toEqual([
      { key: "2026-11-09", calls: 3, input: 1_500_000, output: 100_000, cacheRead: 0, cacheWrite: 0, cost: 7.5 },
      { key: "2026-11-10", calls: 3, input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
  });
});

/* ===== Наблюдение ===== */

async function vapid(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}
async function subscribe(s: Stand, as: string, n = 1) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = b64u(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
  await s.ask("reach.subscribe", { kind: "webpush", endpoint: "https://push.example/sub/" + as + n, p256dh, auth: b64u(crypto.getRandomValues(new Uint8Array(16))) }, as);
}
const pushes = (s: Stand) => s.seen.net.filter((n) => n.url.startsWith("https://push.example/")).map((n) => n.url.split("/").pop());

describe("наблюдение: оповещение о сбоях", () => {
  it("сбой части — одно оповещение админу, даже если он на связи; тот же сбой подряд — молчит; другой сбой — зовёт", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapid() } });
    await subscribe(s, "kyura1");
    await subscribe(s, "kanya1");
    s.state.online.add("~yuri@example.com");
    await s.ask("ledger.add", { what: "host.failed", machine: "laptop", text: "второе падение до готовности" }, "klaptop");
    expect(pushes(s)).toEqual(["kyura11"]);
    await s.ask("ledger.add", { what: "host.failed", machine: "laptop", text: "ещё раз" }, "klaptop");
    expect(pushes(s)).toHaveLength(1);
    await s.ask("ledger.add", { what: "keeper.failed", machine: "laptop", text: "самоподмена не удалась" }, "klaptop");
    expect(pushes(s)).toHaveLength(2);
    // обычное событие журнала никого не зовёт
    await s.ask("ledger.add", { what: "host.updated", machine: "laptop" }, "klaptop");
    expect(pushes(s)).toHaveLength(2);
  });

  it("получатели и выключатель — настройка флота; сбой аналитики после повторов очереди тоже зовёт", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapid(), CH_URL: "https://ch.example" } });
    await subscribe(s, "kyura1");
    await subscribe(s, "kanya1");
    await s.ask("prefs.set", { scope: "fleet", name: "obs.alerts", value: { to: ["~anya@example.com"] } });
    await s.ask("ledger.add", { what: "host.failed", machine: "server", text: "x" }, "klaptop");
    expect(pushes(s)).toEqual(["kanya11"]);
    await s.ask("prefs.set", { scope: "fleet", name: "obs.alerts", value: { off: true } });
    await s.ask("ledger.add", { what: "keeper.failed", machine: "server", text: "x" }, "klaptop");
    expect(pushes(s)).toHaveLength(1);
    await s.ask("prefs.set", { scope: "fleet", name: "obs.alerts", value: null });
    // аналитика: ClickHouse не отвечает и после повторов
    await save(s, { sid: "s1", point: "p1", lines: [{ type: "assistant", uuid: "a1", message: { id: "m1", model: "x", usage: { input_tokens: 1, output_tokens: 1 } } }] });
    s.state.net = (url) => (url.startsWith("https://ch.example") ? new Response("down", { status: 503 }) : new Response(null, { status: 201 }));
    const acked: string[] = [];
    const body: PointNote = { fleet: s.fleet, machine: "laptop", sid: "s1", point: "p1" };
    await consume({ queue: "q", messages: [{ id: "1", timestamp: new Date(), body, attempts: 3, ack: () => acked.push("ack"), retry: () => acked.push("retry") }], ackAll() {}, retryAll() {} } as unknown as MessageBatch<PointNote>, s.env, s.deps);
    expect(acked).toEqual(["ack"]);
    expect(pushes(s)).toEqual(["kanya11", "kyura11"]);
  });

  it("доля отказов выше порога — одно оповещение; ниже числа запросов — молчит", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapid() } });
    await subscribe(s, "kyura1");
    await s.ask("prefs.set", { scope: "fleet", name: "obs.alerts", value: { rate: 0.5, min: 6 } });
    const refused = () => s.ask("keys.set", { name: "k", provider: "p", value: "v" }, "kanya1");
    // до порога числа запросов (subscribe, prefs.set и три отказа — пять строк)
    for (let i = 0; i < 3; i++) await refused();
    expect(pushes(s)).toHaveLength(0);
    for (let i = 0; i < 4; i++) await refused();
    expect(pushes(s)).toHaveLength(1);
  });
});

describe("наблюдение: сводка и поиск", () => {
  it("здоровье флота одним ответом: машины, сессии, отказы, медленные запросы, сбои частей, ошибки с места", async () => {
    const s = stand();
    s.state.sessions = [
      { callsign: "a@laptop", state: "failed", spec: { name: "a", cwd: "~" }, by: "~yuri@example.com", since: 1 },
      { callsign: "b@server", state: "waiting", spec: { name: "b", cwd: "~" }, by: "~yuri@example.com", since: 1 },
      { callsign: "c@oleg-mac", state: "failed", spec: { name: "c", cwd: "~" }, by: "~oleg@example.com", since: 1 },
    ];
    await s.ask("prefs.get", { scope: "me" });
    await s.ask("keys.set", { name: "k", provider: "p", value: "v" }, "kanya1");
    await s.ask("ledger.add", { what: "host.failed", machine: "laptop", text: "второе падение" }, "klaptop");
    await s.ask("obs.report", { part: "web", level: "error", msg: "экран «Работа» упал", stack: "at Work" }, "kanya1");
    const h = (await s.ask("obs.health")).result as any;
    expect(h.machines).toEqual({ total: 4, online: 3, offline: [{ name: "oleg-mac", since: s.machines[3]!.since }] });
    expect(h.sessions).toEqual({ total: 3, failed: ["a@laptop", "c@oleg-mac"], waiting: 1 });
    expect(h.requests).toMatchObject({ n: 3, failed: 1 });
    expect(h.slow.length).toBeGreaterThan(0);
    expect(h.failures).toMatchObject([{ what: "host.failed", machine: "laptop", text: "второе падение", who: "@laptop" }]);
    expect(h.reports).toMatchObject([{ part: "web", level: "error", msg: "экран «Работа» упал", who: "pult~anya@example.com" }]);
    // Аня не достаёт до oleg-mac: его машины и сессии в её сводке нет
    const anya = (await s.ask("obs.health", {}, "kanya1")).result as any;
    expect(anya.machines).toMatchObject({ total: 3, online: 3, offline: [] });
    expect(anya.sessions.failed).toEqual(["a@laptop"]);
  });

  it("ошибка с места видна в списке запросов строкой report; поиск по началу имени запроса", async () => {
    const s = stand();
    await s.ask("prefs.get", { scope: "me" });
    await s.ask("prefs.set", { scope: "me", name: "a", value: 1 });
    await s.ask("ledger.read", {});
    await s.ask("obs.report", { part: "host", level: "warn", msg: "сведение кусочков не прошло" }, "klaptop");
    const recent = async (f: Record<string, unknown>) => ((await s.ask("obs.recent", f)).result as { rows: ObsRow[] }).rows;
    expect((await recent({ name: "prefs." })).map((r) => r.type).sort()).toEqual(["prefs.get", "prefs.set"]);
    expect(await recent({ name: "report" })).toMatchObject([{ type: "report", from: "@laptop", ok: false, word: "warn", why: "host: сведение кусочков не прошло" }]);
    // в сводке по именам ошибок с места нет: это не запросы
    const stats = (await s.ask("obs.stats", { since: 0, until: Date.now() + 1 })).result as { types: { type: string }[] };
    expect(stats.types.map((t) => t.type)).not.toContain("report");
  });
});
