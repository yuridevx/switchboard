// Эталоны служб, третья итерация: поиск по переписке с записью и точкой, обзор архива, фильтры каталога, CORS входа,
// числа Host (ряд и сводка здоровья), оповещения о машине без связи и о сессии со сбоем.
import { describe, expect, it } from "vitest";
import { type ArchSession, type HostMetrics, type SessionRow, sha256hex } from "@sb/protocol";
import { around, blockKey } from "./archive/archive.ts";
import { gzip } from "../r2.ts";
import { b64u } from "./reach/webpush.ts";
import { type Stand, stand } from "../../test/stand.ts";

/** Сохранить точку сессии от имени машины: один файл разговора одним блоком и текст для поиска. */
async function save(s: Stand, sid: string, point: string, text: { uuid: string; text: string }[], o: { as?: string; callsign?: string; tokens?: number } = {}) {
  const as = o.as ?? "klaptop";
  const machine = s.whos.get(s.key(as))!.addr.slice(1);
  const body = text.map((t) => JSON.stringify({ type: "user", uuid: t.uuid, message: { role: "user", content: t.text } })).join("\n") + "\n" + point;
  const hash = await sha256hex(body);
  const put = {
    sid, callsign: o.callsign ?? `site@${machine}`, point, title: "Сессия " + sid, cwd: "~/site", ...(o.tokens !== undefined ? { tokens: o.tokens } : {}),
    files: [{ path: `projects/site/${sid}.jsonl`, blocks: [hash], size: body.length }],
    text: text.map((t) => ({ uuid: t.uuid, role: "user", text: t.text })),
  };
  const first = (await s.ask("points.put", put, as)).result as { upload: Record<string, string>; done: boolean };
  if (first.upload[hash]) await s.env.FILES.put(blockKey(s.fleet, machine, hash), await gzip(new TextEncoder().encode(body)));
  if (!first.done) expect(await s.ask("points.put", { ...put, commit: true }, as)).toMatchObject({ result: { done: true } });
}
const list = async (s: Stand, f: Record<string, unknown>, as = "kyura1") => (await s.ask("points.list", f, as)).result as { sessions: ArchSession[]; more: boolean };

describe("архив: поиск по переписке", () => {
  it("строка вокруг слова — до 60 знаков с каждой стороны, обрыв помечен; слова нет — начало текста", () => {
    const body = "а".repeat(100) + " выкладка " + "б".repeat(100);
    const hit = around(body, "выкладка");
    expect(hit.startsWith("…") && hit.endsWith("…")).toBe(true);
    expect(hit).toContain("выкладка");
    expect(hit.length).toBe(2 + 60 + "выкладка".length + 60);
    expect(around("короткий текст про Выкладку", "выкладку")).toBe("короткий текст про Выкладку");
    expect(around("x".repeat(300), "нет")).toHaveLength(120);
  });

  it("найденная сессия называет запись, точку, с которой запись в архиве, и строку вокруг слова", async () => {
    const s = stand();
    await save(s, "s-find", "p1", [{ uuid: "u-1", text: "начнём с тестов" }]);
    await new Promise((r) => setTimeout(r, 5));
    await save(s, "s-find", "p2", [{ uuid: "u-2", text: "теперь выкладка на стенд и проверка" }]);
    const r = await list(s, { q: "выкладка" });
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ sid: "s-find", hitUuid: "u-2", hitPoint: "p2", hit: "теперь выкладка на стенд и проверка" });
    // запись первой точки находится по первой точке
    expect((await list(s, { q: "тестов" })).sessions[0]).toMatchObject({ hitUuid: "u-1", hitPoint: "p1" });
  });
});

describe("архив: каталог и обзор", () => {
  it("фильтры каталога: машина, не старше, порядок по токенам, предел с признаком «есть ещё»", async () => {
    const s = stand();
    await save(s, "s-a", "p1", [{ uuid: "a1", text: "раз" }], { tokens: 10 });
    await new Promise((r) => setTimeout(r, 5));
    const mid = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    await save(s, "s-b", "p1", [{ uuid: "b1", text: "два" }], { tokens: 500 });
    await save(s, "s-o", "p1", [{ uuid: "o1", text: "три" }], { as: "kolegm", tokens: 99 });
    expect((await list(s, {})).sessions.map((x) => x.sid)).toEqual(["s-o", "s-b", "s-a"]);
    expect((await list(s, { order: "tokens" })).sessions.map((x) => x.sid)).toEqual(["s-b", "s-o", "s-a"]);
    expect((await list(s, { machine: "laptop" })).sessions.map((x) => x.sid)).toEqual(["s-b", "s-a"]);
    expect((await list(s, { since: mid })).sessions.map((x) => x.sid)).toEqual(["s-o", "s-b"]);
    expect((await list(s, { before: mid })).sessions.map((x) => x.sid)).toEqual(["s-a"]);
    const one = await list(s, { limit: 1 });
    expect(one.sessions).toHaveLength(1);
    expect(one.more).toBe(true);
    // Аня не достаёт до машины Олега: его сессии в её каталоге нет, а запрос по его машине — отказ
    expect((await list(s, {}, "kanya1")).sessions.map((x) => x.sid)).toEqual(["s-b", "s-a"]);
    expect(await s.ask("points.list", { machine: "oleg-mac" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("обзор архива: сессии, точки, блоки и размер — всего и по машинам, только своим", async () => {
    const s = stand();
    await save(s, "s-a", "p1", [{ uuid: "a1", text: "раз" }]);
    await save(s, "s-a", "p2", [{ uuid: "a2", text: "два" }]);
    await save(s, "s-o", "p1", [{ uuid: "o1", text: "три" }], { as: "kolegm" });
    const all = (await s.ask("points.stats", {})).result as { sessions: number; points: number; blocks: number; bytes: number; machines: { machine: string; sessions: number; points: number }[] };
    expect(all).toMatchObject({ sessions: 2, points: 3, blocks: 3 });
    expect(all.bytes).toBeGreaterThan(0);
    expect(all.machines.map((m) => [m.machine, m.sessions, m.points])).toEqual([["laptop", 1, 2], ["oleg-mac", 1, 1]]);
    const anya = (await s.ask("points.stats", {}, "kanya1")).result as typeof all;
    expect(anya).toMatchObject({ sessions: 1, points: 2 });
    expect(await s.ask("points.stats", { machine: "oleg-mac" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("вход: страница с другого источника", () => {
  it("предзапрос к /call разрешает заголовок пропуска без кук; ответ несёт разрешение источника", async () => {
    const s = stand();
    const pre = await s.http("/call", { method: "OPTIONS", headers: { origin: "http://localhost:4820", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    const res = await s.http("/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.key("kyura1"), origin: "http://localhost:4820" }, body: JSON.stringify({ type: "prefs.get", id: "r1", scope: "me" }) });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    // сервер MCP — то же
    const mcp = await s.http("/mcp", { method: "OPTIONS" });
    expect(mcp.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});

/* ===== Наблюдение ===== */

const metrics = (at: number, extra: Partial<HostMetrics> = {}): HostMetrics => ({
  at, build: 5, sessions: { idle: 2, busy: 1 }, queue: 1, provider: { n: 10, p50: 800, p95: 2400, failed: 1, retries: 2 }, crashes: 0, resumes: 0, ...extra,
});
async function vapid(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}
async function subscribe(s: Stand, as: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = b64u(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
  await s.ask("reach.subscribe", { kind: "webpush", endpoint: "https://push.example/sub/" + as, p256dh, auth: b64u(crypto.getRandomValues(new Uint8Array(16))) }, as);
}
const pushes = (s: Stand) => s.seen.net.filter((n) => n.url.startsWith("https://push.example/")).length;

describe("наблюдение: числа Host", () => {
  it("числа шлёт только машина; ряд машины читает тот, кто до неё достаёт; сводка здоровья несёт последние числа каждой машины", async () => {
    const s = stand();
    const t = Date.now();
    expect(await s.ask("obs.metrics", metrics(t), "kyura1")).toMatchObject({ ok: false, error: "forbidden" });
    for (const [i, at] of [t - 120_000, t - 60_000, t].entries()) expect((await s.ask("obs.metrics", metrics(at, { queue: i }), "klaptop")).ok).toBe(true);
    await s.ask("obs.metrics", metrics(t, { queue: 7 }), "kolegm");
    const series = (await s.ask("obs.series", { machine: "laptop" })).result as { rows: HostMetrics[] };
    expect(series.rows.map((r) => r.queue)).toEqual([0, 1, 2]);
    expect(series.rows[2]!.provider).toEqual({ n: 10, p50: 800, p95: 2400, failed: 1, retries: 2 });
    expect(((await s.ask("obs.series", { machine: "laptop", since: t - 90_000 })).result as { rows: HostMetrics[] }).rows).toHaveLength(2);
    expect(await s.ask("obs.series", { machine: "oleg-mac" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
    const h = (await s.ask("obs.health")).result as { hosts: (HostMetrics & { machine: string })[] };
    expect(h.hosts.map((x) => [x.machine, x.queue]).sort()).toEqual([["laptop", 2], ["oleg-mac", 7]]);
    // Аня не достаёт до машины Олега: его чисел в её сводке нет
    const anya = (await s.ask("obs.health", {}, "kanya1")).result as typeof h;
    expect(anya.hosts.map((x) => x.machine)).toEqual(["laptop"]);
  });
});

describe("наблюдение: оповещения о машине и сессии", () => {
  const failed = (callsign: string, last = 5): SessionRow => ({ callsign, state: "failed", spec: { name: callsign.split("@")[0]!, cwd: "~" }, by: "~yuri@example.com", since: 1, last, error: "второй сбой до готовности" });

  it("машина без связи дольше порога — одно оповещение админу за этот уход; вернулась и ушла снова — новое", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapid() } });
    await subscribe(s, "kyura1");
    // ушла только что: порог не вышел
    await s.ask("obs.metrics", metrics(Date.now()), "klaptop");
    expect(pushes(s)).toBe(0);
    s.machines[3]!.since = Date.now() - 11 * 60_000;
    await s.ask("ledger.read", {}); // сверка картины — не чаще раза в минуту: первая уже была
    expect(pushes(s)).toBe(0);
    await s.ask("prefs.set", { scope: "fleet", name: "obs.alerts", value: { offline: 5 } });
    const { watchFleet } = await import("./obs/obs.ts");
    const watch = { platform: s.platform, fetch: s.deps.fetch!, log: { info() {}, warn() {}, error() {}, with() { return this; } } as never };
    expect(await watchFleet(s.env, s.fleet, watch)).toBe(1);
    expect(pushes(s)).toBe(1);
    // тот же уход — молчит
    expect(await watchFleet(s.env, s.fleet, watch)).toBe(0);
    // ушла заново — новая причина
    s.machines[3]!.since = Date.now() - 6 * 60_000;
    expect(await watchFleet(s.env, s.fleet, watch)).toBe(1);
    expect(pushes(s)).toBe(2);
    // порог 0 — о машинах не звать
    await s.ask("prefs.set", { scope: "fleet", name: "obs.alerts", value: { offline: 0 } });
    s.machines[3]!.since = Date.now() - 60 * 60_000;
    expect(await watchFleet(s.env, s.fleet, watch)).toBe(0);
  });

  it("сессия со сбоем — одно оповещение за этот сбой; сессия машины без связи и выключатель — молчат", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapid() } });
    await subscribe(s, "kyura1");
    const { watchFleet } = await import("./obs/obs.ts");
    const watch = { platform: s.platform, fetch: s.deps.fetch!, log: { info() {}, warn() {}, error() {}, with() { return this; } } as never };
    s.state.sessions = [failed("a@laptop"), failed("c@oleg-mac")];
    expect(await watchFleet(s.env, s.fleet, watch)).toBe(1);
    expect(pushes(s)).toBe(1);
    expect(await watchFleet(s.env, s.fleet, watch)).toBe(0);
    // сессию запустили, и она упала снова — новый сбой
    s.state.sessions = [failed("a@laptop", 9)];
    expect(await watchFleet(s.env, s.fleet, watch)).toBe(1);
    await s.ask("prefs.set", { scope: "fleet", name: "obs.alerts", value: { failed: false } });
    s.state.sessions = [failed("b@server")];
    expect(await watchFleet(s.env, s.fleet, watch)).toBe(0);
    await s.ask("prefs.set", { scope: "fleet", name: "obs.alerts", value: { off: true } });
    expect(await watchFleet(s.env, s.fleet, watch)).toBe(0);
  });

  it("числа Host от машины — такт сверки картины: оповещение уходит и без запросов людей", async () => {
    const s = stand(undefined, { env: { VAPID_PRIVATE: await vapid() } });
    await subscribe(s, "kyura1");
    const before = pushes(s);
    s.state.sessions = [failed("a@laptop")];
    // подписка уже сверила картину в эту минуту — такт не идёт; через минуту идёт
    await s.ask("obs.metrics", metrics(Date.now()), "klaptop");
    expect(pushes(s)).toBe(before);
    const real = Date.now;
    Date.now = () => real() + 61_000;
    try {
      await s.ask("obs.metrics", metrics(Date.now()), "klaptop");
    } finally {
      Date.now = real;
    }
    expect(pushes(s)).toBe(before + 1);
  });
});
