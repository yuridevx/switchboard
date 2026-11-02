import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import { entries, pack, sha256hex, shaLine } from "@switchboard/release";
import { frame } from "../src/releases.ts";
import type { Env } from "../src/env.ts";

/** Строки журнала releases, которые попали в console.log. */
function journal() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => {
    lines.push(JSON.parse(String(s)));
  });
  return lines;
}

const participant = (exports as unknown as { default: { frame(f: Frame): Promise<Frame[]> } }).default;
type Stand<T> = { got(): Promise<T[]>; delivered(): Promise<T[]>; clear(): Promise<void>; setHosts(n: string[]): Promise<void> };
const E = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const RELAY = E.RELAY as unknown as Stand<Frame>;
const LEDGER = E.LEDGER as unknown as Stand<Frame>;
const GATE = E.GATE as unknown as Stand<never>;
/** машины флота стенда — пропуска роли host у gate */
let known = new Set<string>();
type Stub = { frame(f: Frame): Promise<Frame[]> };
/** Машины флота у gate стенда. */
const hosts = async (...ms: string[]) => {
  for (const m of ms) known.add(m);
  await GATE.setHosts([...known]);
};
/**
 * «Выпуски» на тест: база D1 стенда со строкой флота rev 0. Ответ запроса — кадры, как раньше отдавал объект:
 * reply, затем строки журнала (ушли по привязке LEDGER) и планы keeper'ам (ушли relay.deliver).
 * Вопрос плана от .keeper@машина — POST пропуском машины (@машина); машина становится машиной флота у gate.
 */
const fresh = (): Stub => ({
  async frame(f) {
    let g = f;
    if (f.type === "releases.plan" && typeof f.from === "string" && f.from.startsWith(".keeper@")) {
      const m = f.from.slice(".keeper@".length);
      known.add(m);
      await GATE.setHosts([...known]);
      g = { ...f, from: `@${m}` };
    }
    await RELAY.clear();
    await LEDGER.clear();
    const out = await frame(E, g);
    const back = (r: Frame) => (g.from !== f.from && r.to === g.from ? { ...r, to: f.from } : r);
    return [...out.map(back), ...(await LEDGER.got()).map(({ from: _f, ...x }) => x as Frame), ...(await RELAY.delivered())];
  },
});

/** Имя Worker'а части тестового флота — как в wrangler-настройках модулей. */
const scriptOf = (p: string) => (p === "relay" ? "switchboard" : `switchboard-${p}`);

/** Модуль в каталоге: архив с module.json первой записью и хэш. */
async function inCatalog(name: string, version: string, manifest: Record<string, unknown>) {
  const tgz = pack([{ path: "module.json", data: Buffer.from(JSON.stringify({ name, version, ...manifest })) }]);
  await env.BUCKET.put(`${name}/${version}.tgz`, tgz);
  await env.BUCKET.put(`${name}/${version}.sha256`, shaLine(sha256hex(tgz), version));
}

/** Части Cloudflare в каталоге: модули с именами Worker'а по флотам. */
async function workersIn(parts: Record<string, unknown>) {
  for (const p of Object.keys(parts)) await inCatalog(p, "1.0.0", { type: "worker", workers: { test: scriptOf(p), prod: `${scriptOf(p)}-prod` } });
}

/**
 * Поддельный API Cloudflare: версии Worker'ов с метками, выложенная версия; записывает выкладки.
 * Части — модули каталога с именами Worker'а по флотам: их вид «Выпуски» берут из каталога.
 */
async function fakeCf(parts: Record<string, { tags: string[]; live?: string }>) {
  await workersIn(parts);
  const scripts = Object.fromEntries(Object.entries(parts).map(([p, x]) => [scriptOf(p), x]));
  const deploys: Array<{ script: string; tag: string }> = [];
  const id = (s: string, tag: string) => `${s}-v${tag}`;
  const live = new Map(Object.entries(scripts).map(([s, x]) => [s, x.live ? id(s, x.live) : null]));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const m = new URL(req.url).pathname.match(/^\/client\/v4\/accounts\/acc0\/workers\/scripts\/([^/]+)\/(versions|deployments)$/);
    if (!m || req.headers.get("authorization") !== "Bearer test-token") return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
    const [, s, what] = m;
    const x = scripts[s];
    if (!x) return Response.json({ success: false, errors: [{ code: 10007, message: "no script" }] }, { status: 404 });
    if (what === "versions") return Response.json({ success: true, result: { items: [...x.tags].reverse().map((t) => ({ id: id(s, t), annotations: { "workers/tag": t } })) } });
    if (req.method === "GET") return Response.json({ success: true, result: { deployments: live.get(s) ? [{ versions: [{ version_id: live.get(s), percentage: 100 }] }] : [] } });
    const body = (await req.json()) as { versions: Array<{ version_id: string; percentage: number }> };
    live.set(s, body.versions[0].version_id);
    deploys.push({ script: s, tag: body.versions[0].version_id.slice(s.length + 2) });
    return Response.json({ success: true, result: { id: "dep" } });
  });
  return deploys;
}

/** Готовая версия части машины в R2: архив без манифеста (как сборка Host) и хэш. */
const tgzOf = (part: string, v: string) => pack([{ path: "app.json", data: Buffer.from(`${part} ${v}`) }]);
async function inR2(part: string, ...vs: string[]) {
  for (const v of vs) {
    const tgz = tgzOf(part, v);
    await env.BUCKET.put(`${part}/${v}.tgz`, tgz);
    await env.BUCKET.put(`${part}/${v}.sha256`, shaLine(sha256hex(tgz), v));
  }
}

const req = (s: Stub, from: string, type: string, extra: Record<string, unknown> = {}) => s.frame({ type, v: 1, id: "r", to: ".releases", from, ...extra });
const result = async (p: Promise<Frame[]>) => {
  const [r] = await p;
  expect(r).toMatchObject({ type: "reply", ok: true });
  return r.result as any;
};
const plans = (out: Frame[]) => out.filter((f) => f.type === "releases.plan");
const brief = (f: Frame) => ({ to: f.to, rev: f.rev, parts: (f.parts as Array<Record<string, unknown>>).map(({ url: _u, sha256: _s, ...rest }) => rest) });

const NONE = { relay: { tags: [] }, gate: { tags: [] }, push: { tags: [] }, points: { tags: [] }, ledger: { tags: [] }, github: { tags: [] }, releases: { tags: [] }, phone: { tags: [] }, pult: { tags: [] } };

beforeEach(async () => {
  for (const o of (await env.BUCKET.list()).objects) await env.BUCKET.delete(o.key);
  await applyD1Migrations(E.DB, E.TEST_MIGRATIONS);
  await E.DB.exec("UPDATE fleet SET stable = '{}', plans = '{}', rev = 0 WHERE one = 1");
  known = new Set();
  await GATE.setHosts([]);
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны releases", () => {
  it("2 · первый вопрос keeper: план пустой — keeper и host за stable, ссылка на час, машина в списке", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.57");
    await inR2("keeper", "0.5.0");
    await req(s, "~x", "releases.deploy", { part: "host" });
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    const p = await result(req(s, ".keeper@win", "releases.plan"));
    expect(p.rev).toBe(2);
    expect(p.parts.map((x: any) => [x.part, x.version, x.sha256])).toEqual([
      ["keeper", "0.5.0", sha256hex(tgzOf("keeper", "0.5.0"))],
      ["host", "1.1.57", sha256hex(tgzOf("host", "1.1.57"))],
    ]);
    expect(p.parts[1].url).toMatch(/^https:\/\/acc0\.r2\.cloudflarestorage\.com\/switchboard-releases\/host\/1\.1\.57\.tgz\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AK%2F\d{8}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=\d{8}T\d{6}Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/);
    expect((await result(req(s, "~x", "releases.list"))).machines).toEqual([{ machine: "win", plan: {} }]);
  });

  it("3 · 5071 · план спрашивает машина: POST пропуском машины (@win) и keeper кадром (.keeper@win); часть не keeper и клиент — bad_frame", async () => {
    const s = fresh();
    expect((await req(s, "@win", "releases.plan"))[0]).toMatchObject({ type: "reply", id: "r", ok: true, to: "@win" });
    expect((await req(s, ".host@win", "releases.plan"))[0]).toMatchObject({ ok: false, error: "bad_frame" });
    expect((await req(s, "panel~o", "releases.plan"))[0]).toMatchObject({ ok: false, error: "bad_frame" });
    // машины флота — пропуска роли host у gate: своего списка машин у «Выпусков» нет
    await fakeCf(NONE);
    expect((await result(req(s, "~x", "releases.list"))).machines).toEqual([]);
    await hosts("win");
    expect((await result(req(s, "~x", "releases.list"))).machines).toEqual([{ machine: "win", plan: {} }]);
  });

  it("4 · вся сборка одним вызовом: части сборки на свою edge, план на .keeper@ каждой машины, приложение не тронуто", async () => {
    const s = fresh();
    await inR2("host", "1.1.57", "1.1.58");
    await inR2("keeper", "0.5.0");
    await inR2("capture", "1.4.0", "1.5.0");
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.57" });
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    await req(s, "~x", "releases.deploy", { part: "capture", version: "1.4.0" });
    await req(s, ".keeper@win", "releases.plan");
    await req(s, ".keeper@wsl", "releases.plan");
    await req(s, "~x", "releases.set", { machine: "win", part: "capture", on: true });
    const deploys = await fakeCf({
      ...Object.fromEntries(Object.keys(NONE).map((k) => [k, { tags: ["1.1.58"], live: "1.1.58" }])),
      relay: { tags: ["1.1.57", "1.1.58"], live: "1.1.57" },
    });
    const out = await req(s, "~yuri", "releases.deploy", { part: "*" });
    expect(out[0]).toMatchObject({ type: "reply", ok: true, to: "~yuri" });
    const r = (out[0].result as any).parts;
    expect(r.host).toEqual({ from: "1.1.57", to: "1.1.58" });
    expect(r.keeper).toEqual({ from: "0.5.0", to: "0.5.0" });
    expect(r.relay).toEqual({ from: "1.1.57", to: "1.1.58" });
    expect(r.capture).toBeUndefined();
    expect(Object.keys(r).pop()).toBe("relay");
    expect(plans(out).map(brief)).toEqual([
      { to: ".keeper@win", rev: 5, parts: [{ part: "keeper", version: "0.5.0" }, { part: "host", version: "1.1.58" }, { part: "capture", version: "1.4.0" }] },
      { to: ".keeper@wsl", rev: 5, parts: [{ part: "keeper", version: "0.5.0" }, { part: "host", version: "1.1.58" }] },
    ]);
    // 5072 · перемена плана → relay.deliver: кадр .keeper@машина в объект её машины, from .releases
    const sent = (await (env.RELAY as unknown as { delivered(): Promise<any[]> }).delivered()).filter((f: any) => f.rev === 5);
    expect(sent.map((f: any) => [f.to, f.from])).toEqual([[".keeper@win", ".releases"], [".keeper@wsl", ".releases"]]);
    expect(out.filter((f) => f.type === "ledger.add").map((f) => [f.ev, f.text, f.by])).toEqual([
      ["part.deployed", "relay 1.1.57 → 1.1.58", "~yuri"],
      ["part.deployed", "host 1.1.57 → 1.1.58", "~yuri"],
    ]);
    expect(deploys).toEqual([{ script: "switchboard", tag: "1.1.58" }]);
  });

  it("4b · Cloudflare отказал посреди «*»: stable частей машины прежний; повтор с исправным Cloudflare — план keeper с новой rev", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.57", "1.1.58");
    await inR2("keeper", "0.5.0");
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.57" });
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    await req(s, ".keeper@win", "releases.plan");
    // у gate версия есть, у github — нет: отказ на второй части Cloudflare
    await fakeCf({ ...NONE, gate: { tags: ["1.1.58"], live: "1.1.57" } });
    expect((await req(s, "~x", "releases.deploy", { part: "*" }))[0]).toMatchObject({ ok: false, error: "no_release" });
    expect((await result(req(s, "~x", "releases.list", { part: "host" }))).parts.host.stable).toBe("1.1.57");
    await fakeCf(Object.fromEntries(Object.keys(NONE).map((k) => [k, { tags: ["1.1.58"], live: "1.1.58" }])));
    const out = await req(s, "~x", "releases.deploy", { part: "*" });
    expect((out[0].result as any).parts.host).toEqual({ from: "1.1.57", to: "1.1.58" });
    expect(plans(out).map(brief)).toEqual([{ to: ".keeper@win", rev: 3, parts: [{ part: "keeper", version: "0.5.0" }, { part: "host", version: "1.1.58" }] }]);
  });

  it("5 · откат Worker одним вызовом: одна выкладка в Cloudflare, планы машин не меняются", async () => {
    const s = fresh();
    const deploys = await fakeCf({ ...NONE, relay: { tags: ["1.1.58", "1.1.59", "1.1.60"], live: "1.1.60" } });
    await req(s, ".keeper@win", "releases.plan");
    const out = await req(s, "~x", "releases.deploy", { part: "relay", version: "1.1.58" });
    expect(out[0].result).toEqual({ parts: { relay: { from: "1.1.60", to: "1.1.58" } } });
    expect(deploys).toEqual([{ script: "switchboard", tag: "1.1.58" }]);
    expect(plans(out)).toEqual([]);
    expect(out.filter((f) => f.type === "ledger.add").map((f) => [f.ev, f.text, f.by])).toEqual([["part.deployed", "relay 1.1.60 → 1.1.58", "~x"]]);
    expect((await result(req(s, "~x", "releases.list", { part: "relay" }))).rev).toBe(0);
  });

  it("6 · закреплённая не следует за stable: pin 1.3.2 у pc2, deploy capture 1.4.0 — план pc2 не меняется", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.3.2", "1.4.0");
    await req(s, "~x", "releases.deploy", { part: "capture", version: "1.3.2" });
    await req(s, "~x", "releases.set", { machine: "pc2", part: "capture", pin: "1.3.2" });
    await req(s, "~x", "releases.set", { machine: "win", part: "capture" });
    await hosts("win", "pc2");
    // у laptop capture в плане нет — план ему не уходит
    await req(s, ".keeper@laptop", "releases.plan");
    const rev = (await result(req(s, "~x", "releases.list", { part: "capture" }))).rev;
    const out = await req(s, "~x", "releases.deploy", { part: "capture", version: "1.4.0" });
    expect(out[0].result).toEqual({ parts: { capture: { from: "1.3.2", to: "1.4.0" } } });
    expect(plans(out).map((f) => [f.to, f.rev])).toEqual([[".keeper@win", rev + 1]]);
    expect(out.filter((f) => f.type === "ledger.add").map((f) => f.text)).toEqual(["capture 1.3.2 → 1.4.0"]);
    expect((await result(req(s, ".keeper@pc2", "releases.plan"))).parts.map((x: any) => x.version)).toEqual(["1.3.2"]);
  });

  it("7 · машина вернулась на связь: при подключении keeper получает план с новой stable", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.3.2", "1.4.0");
    await req(s, "~x", "releases.deploy", { part: "capture", version: "1.3.2" });
    await req(s, "~x", "releases.set", { machine: "laptop", part: "capture" });
    await req(s, "~x", "releases.deploy", { part: "capture" });
    const p = await result(req(s, ".keeper@laptop", "releases.plan"));
    expect(p.parts.map((x: any) => [x.part, x.version])).toEqual([["capture", "1.4.0"]]);
  });

  it("8 · версия загружается один раз: вторая загрузка — version_exists, R2 не тронут", async () => {
    const s = fresh();
    await inR2("capture", "1.4.0");
    expect((await req(s, "~x", "releases.upload", { part: "capture", version: "1.4.0" }))[0]).toMatchObject({ ok: false, error: "version_exists" });
    const u = await result(req(s, "~x", "releases.upload", { part: "capture", version: "1.5.0" }));
    expect(u.tgz).toMatch(/^https:\/\/acc0\.r2\.cloudflarestorage\.com\/switchboard-releases\/capture\/1\.5\.0\.tgz\?.*X-Amz-Signature=/);
    expect(u.sha256).toMatch(/\/capture\/1\.5\.0\.sha256\?/);
    expect((await req(s, "~x", "releases.upload", { part: "capture", version: "1.5" }))[0]).toMatchObject({ error: "bad_version" });
    // модуль-Worker тоже загружается в каталог: в архиве его module.json
    expect((await req(s, "~x", "releases.upload", { part: "relay", version: "1.5.0" }))[0]).toMatchObject({ ok: true });
    expect((await req(s, "~x", "releases.upload", { part: "Cap ture", version: "1.5.0" }))[0]).toMatchObject({ error: "bad_frame" });
  });

  it("5144 · загрузка с хэшем: тот же лежит — same без ссылок, другой — version_exists; архив без хэша — ссылки снова; хэш не того вида — bad_frame", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): CI грузит модули запросом releases.upload —
    // повтор прогона с теми же модулями проходит; архив без хэша — версия не готова: факт — перезапуск CI №80 после обрыва
    const s = fresh();
    await inR2("capture", "1.4.0");
    const sha = sha256hex(tgzOf("capture", "1.4.0"));
    expect(await result(req(s, "~x", "releases.upload", { part: "capture", version: "1.4.0", sha256: sha }))).toEqual({ same: true });
    expect((await req(s, "~x", "releases.upload", { part: "capture", version: "1.4.0", sha256: "0".repeat(64) }))[0]).toMatchObject({ ok: false, error: "version_exists" });
    await env.BUCKET.put("capture/1.6.0.tgz", "half");
    const again = await result(req(s, "~x", "releases.upload", { part: "capture", version: "1.6.0", sha256: sha }));
    expect(again.tgz).toMatch(/\/capture\/1\.6\.0\.tgz\?/);
    expect((await req(s, "~x", "releases.upload", { part: "capture", version: "1.7.0", sha256: "abc" }))[0]).toMatchObject({ ok: false, error: "bad_frame" });
  });

  it("9 · set: выключить силой, окружение, снять; у keeper только pin; уже так — ok с прежней rev", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.4.0");
    await inR2("keeper", "0.5.0", "0.6.0");
    await req(s, "~x", "releases.deploy", { part: "capture" });
    expect(await result(req(s, "~x", "releases.set", { machine: "win", part: "capture", env: { SITE: "lab" } }))).toEqual({ machine: "win", rev: 2 });
    const off = await req(s, "~x", "releases.set", { machine: "win", part: "capture", on: false, force: true });
    expect(plans(off).map(brief)).toEqual([{ to: ".keeper@win", rev: 3, parts: [{ part: "capture", version: "1.4.0", on: false, force: true, env: { SITE: "lab" } }] }]);
    expect(await req(s, "~x", "releases.set", { machine: "win", part: "capture", on: false, force: true })).toEqual([{ type: "reply", id: "r", ok: true, result: { machine: "win", rev: 3 }, to: "~x" }]);
    const on = await req(s, "~x", "releases.set", { machine: "win", part: "capture", on: true });
    expect(brief(plans(on)[0]).parts).toEqual([{ part: "capture", version: "1.4.0", env: { SITE: "lab" } }]);
    expect((await req(s, "~x", "releases.set", { machine: "win", part: "keeper", on: false }))[0]).toMatchObject({ error: "bad_frame" });
    expect(brief(plans(await req(s, "~x", "releases.set", { machine: "win", part: "keeper", pin: "0.6.0" }))[0]).parts[0]).toEqual({ part: "keeper", version: "0.6.0" });
    expect((await req(s, "~x", "releases.set", { machine: "win", part: "keeper", pin: "0.9.0" }))[0]).toMatchObject({ error: "no_release" });
    expect(brief(plans(await req(s, "~x", "releases.set", { machine: "win", part: "capture", remove: true }))[0]).parts).toEqual([{ part: "keeper", version: "0.6.0" }]);
    expect((await req(s, "~x", "releases.set", { machine: "win", part: "capture", remove: true }))[0]).toMatchObject({ error: "no_part" });
    expect((await req(s, "~x", "releases.set", { machine: "win", part: "probe", on: true }))[0]).toMatchObject({ error: "no_release" });
  });

  it("10 · list: части машины и Cloudflare с edge и stable, машины с планами", async () => {
    const s = fresh();
    await fakeCf({ ...NONE, relay: { tags: ["1.1.58", "1.1.60"], live: "1.1.58" } });
    await inR2("host", "1.1.57", "1.1.58");
    await inR2("capture", "1.4.0", "1.10.0");
    // 1.1.59 без хэша — не готова и в edge не идёт
    await env.BUCKET.put("host/1.1.59.tgz", "half");
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.57" });
    await req(s, "~x", "releases.set", { machine: "pc2", part: "capture", pin: "1.4.0" });
    await hosts("pc2");
    const l = await result(req(s, "~x", "releases.list"));
    expect(l.parts.host).toEqual({ where: "machine", edge: "1.1.58", stable: "1.1.57" });
    expect(l.parts.capture).toEqual({ where: "machine", edge: "1.10.0", stable: null });
    expect(l.parts.relay).toEqual({ where: "cloud", edge: "1.1.60", stable: "1.1.58" });
    expect(l.parts.pult).toEqual({ where: "cloud", edge: null, stable: null });
    expect(l.machines).toEqual([{ machine: "pc2", plan: { capture: { pin: "1.4.0" } } }]);
    expect(Object.keys((await result(req(s, "~x", "releases.list", { part: "host" }))).parts)).toEqual(["host"]);
  });

  it("11 · нет версии — no_release: у части машины нет версии или хэша, у Worker'а нет метки; stable и rev не меняются", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.57");
    await req(s, "~x", "releases.deploy", { part: "host" });
    expect((await req(s, "~x", "releases.deploy", { part: "host", version: "9.9.9" }))[0]).toMatchObject({ ok: false, error: "no_release" });
    expect((await req(s, "~x", "releases.deploy", { part: "push", version: "9.9.9" }))[0]).toMatchObject({ ok: false, error: "no_release" });
    expect((await req(s, "~x", "releases.deploy", { part: "push" }))[0]).toMatchObject({ ok: false, error: "no_release" });
    const l = await result(req(s, "~x", "releases.list", { part: "host" }));
    expect([l.parts.host.stable, l.rev]).toEqual(["1.1.57", 1]);
  });

  it("12 · вход по привязке: ответом — только reply; строка журнала — по привязке LEDGER с from .releases, план — relay.deliver", async () => {
    await hosts("box");
    const sent = await participant.frame({ type: "releases.plan", v: 1, id: "q", to: ".releases", from: "@box" });
    expect(sent.map((x) => [x.type, x.to])).toEqual([["reply", "@box"]]);
    await fakeCf(NONE);
    await inR2("host", "7.7.7");
    await RELAY.clear();
    await LEDGER.clear();
    const out = await participant.frame({ type: "releases.deploy", v: 1, id: "d1", to: ".releases", from: "panel~o", part: "host", version: "7.7.7" });
    expect(out.map((x) => [x.type, x.to])).toEqual([["reply", "panel~o"]]);
    expect((await LEDGER.got()).map((x) => [x.type, x.from, x.text])).toEqual([["ledger.add", ".releases", "host — → 7.7.7"]]);
    expect((await RELAY.delivered()).map((x) => [x.type, x.to, x.from])).toEqual([["releases.plan", ".keeper@box", ".releases"]]);
  });

  it("5073 · две правки плана одновременно — одна прошла, вторая conflict; строка флота — от первой, rev +1", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.82");
    await req(s, "~x", "releases.deploy", { part: "host" });
    const [a, b] = await Promise.all([
      req(s, "~x", "releases.set", { machine: "win", part: "host", on: false }),
      req(s, "~x", "releases.set", { machine: "wsl", part: "host", on: false }),
    ]);
    expect([a[0].ok, b[0].ok].sort()).toEqual([false, true]);
    expect([a[0], b[0]].find((r) => !r.ok)).toMatchObject({ error: "conflict" });
    const row = await E.DB.prepare("SELECT plans, rev FROM fleet WHERE one = 1").first<{ plans: string; rev: number }>();
    expect([Object.keys(JSON.parse(row!.plans)).length, row!.rev]).toEqual([1, 2]);
  });

  it("2030 · вход отклонён: чужое имя — unknown_request, другая версия — contract_mismatch, без id — только строка, reply — note", async () => {
    const s = fresh();
    const log = journal();
    expect((await req(s, "~x", "releases.nope"))[0]).toMatchObject({ ok: false, error: "unknown_request", to: "~x" });
    expect((await req(s, "~x", "releases.list", { v: 2 }))[0]).toMatchObject({ ok: false, error: "contract_mismatch" });
    expect(await s.frame({ type: "releases.list", v: 1, to: ".releases", from: "~x" })).toEqual([]);
    expect(await s.frame({ type: "reply", id: "x", ok: true, to: ".releases", from: "~x" })).toEqual([]);
    expect(log.map((l) => [l.kind, l.word ?? l.ev])).toEqual([
      ["refuse", "unknown_request"],
      ["refuse", "contract_mismatch"],
      ["refuse", "bad_frame"],
      ["note", "reply"],
    ]);
  });

  it("2034 · версия без хэша — не в плане, строка stop", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("keeper", "1.0.1");
    await inR2("host", "1.1.59");
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    await req(s, "~x", "releases.deploy", { part: "host" });
    // stable host остаётся 1.1.59, а его хэш пропал: версия не готова
    await env.BUCKET.delete("host/1.1.59.sha256");
    const log = journal();
    const p = await result(req(s, ".keeper@win", "releases.plan"));
    expect(p.parts.map((x: any) => x.part)).toEqual(["keeper"]);
    expect(log).toContainEqual(expect.objectContaining({ kind: "stop", ev: "releases.plan", machine: "win", why: "у host 1.1.59 нет хэша в R2 — часть не в плане" }));
  });

  it("2035 · флот без stable — пустой план без строки stop", async () => {
    const s = fresh();
    const log = journal();
    expect(await result(req(s, ".keeper@win", "releases.plan"))).toEqual({ rev: 0, parts: [] });
    expect(log.filter((l) => l.kind === "stop")).toEqual([]);
  });

  it("2036 · list: API Cloudflare не ответил — cf_failed, статус и errors в журнале, без токена", async () => {
    const s = fresh();
    await workersIn(NONE);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 }));
    const log = journal();
    expect(await req(s, "~x", "releases.list")).toEqual([{ type: "reply", id: "r", ok: false, error: "cf_failed", to: "~x" }]);
    expect(log).toContainEqual(expect.objectContaining({ ev: "releases.list", word: "cf_failed", status: 403 }));
    expect(JSON.stringify(log)).not.toContain("test-token");
  });

  it("3125 · API Cloudflare держит соединение и не отвечает — за предел 8 с отказ cf_failed с причиной, stable и rev прежние", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит и поддержка graceful shutdown»;
    // предел — вдвое выше самого долгого замера выкладки одной части целиком (3,6 с, три обращения к API)
    const s = fresh();
    await workersIn(NONE);
    await inR2("host", "1.4.0");
    await inR2("keeper", "1.0.0");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_i: RequestInfo | URL, init?: RequestInit) => new Promise((_ok, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal!.reason))),
    );
    const log = journal();
    const t = Date.now();
    const [r] = await req(s, "~x", "releases.deploy", { part: "*" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(7_900);
    expect(r).toMatchObject({ type: "reply", ok: false, error: "cf_failed" });
    expect(log).toContainEqual(expect.objectContaining({ ev: "releases.deploy", word: "cf_failed", why: "API Cloudflare: не ответил за 8 с" }));
    vi.restoreAllMocks();
    await fakeCf(NONE);
    expect((await result(req(s, "~x", "releases.list"))).parts.host.stable).toBeNull();
  }, 20_000);

  it("3126 · повтор всей сборки — без перемен: from = to, ни одной выкладки, ни ledger.add, ни плана, rev прежняя", async () => {
    // источник: чьё: код (выкладка — только если выложена другая версия); факт — после живых эталонов агент повторяет «*»
    const s = fresh();
    await inR2("host", "1.1.58");
    await inR2("keeper", "0.5.0");
    const all = Object.fromEntries(Object.keys(NONE).map((k) => [k, { tags: ["1.1.58"], live: "1.1.58" }]));
    await fakeCf(all);
    await req(s, "~x", "releases.deploy", { part: "*" });
    await req(s, ".keeper@win", "releases.plan");
    const rev = (await result(req(s, "~x", "releases.list"))).rev;
    vi.restoreAllMocks();
    const deploys = await fakeCf(all);
    const out = await req(s, "~x", "releases.deploy", { part: "*" });
    const r = (out[0].result as any).parts;
    for (const k of Object.keys(r)) expect(r[k].from).toBe(r[k].to);
    expect(deploys).toEqual([]);
    expect(out.filter((f) => f.type !== "reply")).toEqual([]);
    expect((await result(req(s, "~x", "releases.list"))).rev).toBe(rev);
  });

  it("3127 · часть Cloudflare выложена мимо «выпусков» — «*» возвращает её на версию с меткой, from null, запись «gate — → 1.1.82»", async () => {
    // источник: факт (живые эталоны выкладывают gate мимо «выпусков», после них — releases.deploy *); чьё: код
    const s = fresh();
    await inR2("host", "1.1.82");
    await inR2("keeper", "0.5.0");
    const deploys = await fakeCf({ ...Object.fromEntries(Object.keys(NONE).map((k) => [k, { tags: ["1.1.82"], live: "1.1.82" }])), gate: { tags: ["1.1.82"], live: "ручная" } });
    const out = await req(s, "~yuri", "releases.deploy", { part: "*" });
    expect((out[0].result as any).parts.gate).toEqual({ from: null, to: "1.1.82" });
    expect(deploys).toEqual([{ script: "switchboard-gate", tag: "1.1.82" }]);
    expect(out.filter((f) => f.type === "ledger.add").map((f) => [f.text, f.by])).toContainEqual(["gate — → 1.1.82", "~yuri"]);
  });

  it("3128 · загрузка не дописана: edge части машины — последняя версия с хэшем; названная версия без хэша — no_release, stable и rev прежние", async () => {
    // источник: чьё: код («готова та, у которой лежит .sha256»); факт — загрузка кладёт .tgz, затем .sha256
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.81", "1.1.82");
    await env.BUCKET.put("host/1.1.83.tgz", "host 1.1.83");
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.81" });
    await req(s, ".keeper@win", "releases.plan");
    expect((await result(req(s, "~x", "releases.deploy", { part: "host" }))).parts.host).toEqual({ from: "1.1.81", to: "1.1.82" });
    const rev = (await result(req(s, "~x", "releases.list"))).rev;
    const out = await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.83" });
    expect(out).toEqual([expect.objectContaining({ type: "reply", ok: false, error: "no_release" })]);
    const l = await result(req(s, "~x", "releases.list"));
    expect([l.parts.host.stable, l.parts.host.edge, l.rev]).toEqual(["1.1.82", "1.1.82", rev]);
  });

  it("3129 · приложение на версию — план только машинам, где оно за stable; запись в журнал флота", async () => {
    // источник: чьё: код (план меняется у машин, где часть идёт за stable)
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.4.0", "1.5.0");
    await inR2("keeper", "0.5.0");
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    await req(s, "~x", "releases.deploy", { part: "capture", version: "1.4.0" });
    await req(s, ".keeper@win", "releases.plan");
    await req(s, ".keeper@wsl", "releases.plan");
    await req(s, "~x", "releases.set", { machine: "win", part: "capture", on: true });
    const out = await req(s, "~x", "releases.deploy", { part: "capture", version: "1.5.0" });
    expect(plans(out).map((f) => f.to)).toEqual([".keeper@win"]);
    expect(out.filter((f) => f.type === "ledger.add").map((f) => f.text)).toEqual(["capture 1.4.0 → 1.5.0"]);
  });

  it("3130 · убрать запись host — host снова за stable и в плане остаётся", async () => {
    // источник: чьё: код (keeper и host в плане всегда)
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.82");
    await req(s, "~x", "releases.deploy", { part: "host" });
    await hosts("win");
    await req(s, "~x", "releases.set", { machine: "win", part: "host", on: false });
    const out = await req(s, "~x", "releases.set", { machine: "win", part: "host", remove: true });
    expect(brief(plans(out)[0]).parts).toEqual([{ part: "host", version: "1.1.82" }]);
    expect((await result(req(s, "~x", "releases.list"))).machines).toContainEqual({ machine: "win", plan: {} });
  });

  it("3131 · окружение задать и снять: второй шаг — rev +1, в плане часть без env", async () => {
    // источник: чьё: код
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.4.0");
    await req(s, "~x", "releases.deploy", { part: "capture" });
    await req(s, "~x", "releases.set", { machine: "win", part: "capture", env: { SITE: "lab" } });
    const out = await req(s, "~x", "releases.set", { machine: "win", part: "capture", env: {} });
    expect(brief(plans(out)[0])).toEqual({ to: ".keeper@win", rev: 3, parts: [{ part: "capture", version: "1.4.0" }] });
  });

  it("3132 · правка машины без отличий, которая ничего не меняет, — «уже так»: rev прежняя, плана нет; машина в списке — по пропуску у gate", async () => {
    // источник: дизайн «Открытый флот» — своего списка машин у «Выпусков» нет, машины — пропуска роли host
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.82");
    await req(s, "~x", "releases.deploy", { part: "host" });
    await hosts("pc3");
    const out = await req(s, "~x", "releases.set", { machine: "pc3", part: "host", on: true });
    expect(out[0]).toMatchObject({ ok: true, result: { machine: "pc3", rev: 1 } });
    expect(plans(out)).toEqual([]);
    expect((await result(req(s, "~x", "releases.list"))).machines).toContainEqual({ machine: "pc3", plan: {} });
  });

  it("3133 · pin на версию без хэша (загрузка оборвалась между архивом и хэшем) — no_release, план и rev прежние", async () => {
    // источник: чьё: код («готова та, у которой лежит .sha256»)
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.82");
    await req(s, "~x", "releases.deploy", { part: "host" });
    await env.BUCKET.put("sbprobe/1.0.1.tgz", "x");
    const out = await req(s, "~x", "releases.set", { machine: "win", part: "sbprobe", pin: "1.0.1" });
    expect(out).toEqual([expect.objectContaining({ ok: false, error: "no_release" })]);
    expect((await result(req(s, "~x", "releases.list"))).rev).toBe(1);
  });

  it("2037 · Cloudflare отказал посреди «*» — cf_failed, stable частей машины и rev прежние, планов нет", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("keeper", "1.0.1");
    await inR2("host", "1.1.58", "1.1.59");
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.58" });
    await req(s, ".keeper@win", "releases.plan");
    const okCf = await fakeCf(Object.fromEntries(Object.keys(NONE).map((k) => [k, { tags: ["1.1.58"], live: "1.1.58" }])));
    void okCf;
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      new Request(input, init).url.includes("/switchboard-push/") ? Response.json({ success: false, errors: [{ code: 10013 }] }, { status: 500 }) : real(input, init),
    );
    const out = await req(s, "~x", "releases.deploy", { part: "*" });
    expect(out).toEqual([{ type: "reply", id: "r", ok: false, error: "cf_failed", to: "~x" }]);
    vi.restoreAllMocks();
    await fakeCf(NONE);
    const l = await result(req(s, "~x", "releases.list", { part: "host" }));
    expect([l.parts.host.stable, l.rev]).toEqual(["1.1.58", 2]);
  });

  it("2092 · Cloudflare отказал посреди «*» — уже выложенные части Cloudflare в журнале флота, отказ cf_failed", async () => {
    // источник: устав «система ловит»: отказ — словом, причина — в журнале; факт цикла тестов 2 нояб. — записи выложенных частей терялись
    const s = fresh();
    await fakeCf(Object.fromEntries(Object.keys(NONE).map((k) => [k, { tags: ["1.1.58", "1.1.59"], live: "1.1.58" }])));
    await inR2("keeper", "1.0.1");
    await inR2("host", "1.1.58");
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      new Request(input, init).url.includes("/switchboard-points/") ? Response.json({ success: false, errors: [{ code: 10013 }] }, { status: 500 }) : real(input, init),
    );
    const out = await req(s, "~x", "releases.deploy", { part: "*" });
    expect(out[0]).toEqual({ type: "reply", id: "r", ok: false, error: "cf_failed", to: "~x" });
    // порядок выкладки — части Cloudflare по имени, relay последним: до points выложены gate, github, ledger, phone
    expect(out.slice(1).map((f) => [f.type, f.to, f.text])).toEqual([
      ["ledger.add", ".ledger", "gate 1.1.58 → 1.1.59"],
      ["ledger.add", ".ledger", "github 1.1.58 → 1.1.59"],
      ["ledger.add", ".ledger", "ledger 1.1.58 → 1.1.59"],
      ["ledger.add", ".ledger", "phone 1.1.58 → 1.1.59"],
    ]);
  });

  it("2094 · у Worker'а нет версии посреди «*» — no_release, выложенные до него части Cloudflare в журнале флота", async () => {
    // источник: устав «система ловит»: отказ — словом, причина — в журнале
    const s = fresh();
    await fakeCf({ ...Object.fromEntries(Object.keys(NONE).map((k) => [k, { tags: ["1.1.58", "1.1.59"], live: "1.1.58" }])), points: { tags: [] } });
    await inR2("keeper", "1.0.1");
    await inR2("host", "1.1.58");
    const out = await req(s, "~x", "releases.deploy", { part: "*" });
    expect(out[0]).toMatchObject({ type: "reply", ok: false, error: "no_release" });
    expect(out.slice(1).map((f) => f.text)).toEqual(["gate 1.1.58 → 1.1.59", "github 1.1.58 → 1.1.59", "ledger 1.1.58 → 1.1.59", "phone 1.1.58 → 1.1.59"]);
  });

  it("5112 · вид части — из каталога: Worker — по workers.<FLEET> модуля, сборка Host и os — части машины, модуль Host частью не бывает", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): «Выпуски» знают свой флот одной строкой настройки, списков Worker'ов нет
    const s = fresh();
    await fakeCf({ push: { tags: ["1.0.3"], live: "1.0.3" } });
    await inCatalog("host-chat", "1.0.2", { type: "sdk", into: ["host"] });
    await inCatalog("capture", "2.0.0", { type: "os" });
    await inR2("host", "1.1.85");
    const l = await result(req(s, "~x", "releases.list"));
    expect(l.parts).toEqual({
      capture: { where: "machine", edge: "2.0.0", stable: null },
      host: { where: "machine", edge: "1.1.85", stable: null },
      push: { where: "cloud", edge: "1.0.3", stable: "1.0.3" },
    });
    expect(vi.mocked(fetch).mock.calls.map(([u]) => new URL(String(u)).pathname.split("/")[7])).toEqual(["switchboard-push", "switchboard-push"]);
    expect((await req(s, "~x", "releases.set", { machine: "win", part: "push", on: false }))[0]).toMatchObject({ error: "bad_frame" });
  });

  it("2039 · deploy части сборки: stable, rev, план машинам за stable, ledger.add с by; повтор — без перемен", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.58", "1.1.59");
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.58" });
    await req(s, ".keeper@laptop", "releases.plan");
    await req(s, ".keeper@pc", "releases.plan");
    await req(s, "~x", "releases.set", { machine: "wsl", part: "host", pin: "1.1.58" });
    const rev = (await result(req(s, "~x", "releases.list", { part: "host" }))).rev;
    const out = await req(s, "panel~o", "releases.deploy", { part: "host" });
    expect(out[0].result).toEqual({ parts: { host: { from: "1.1.58", to: "1.1.59" } } });
    expect(plans(out).map((f) => [f.to, f.rev, f.v])).toEqual([
      [".keeper@laptop", rev + 1, 1],
      [".keeper@pc", rev + 1, 1],
    ]);
    expect(out.filter((f) => f.type === "ledger.add").map((f) => [f.ev, f.text, f.by])).toEqual([["part.deployed", "host 1.1.58 → 1.1.59", "panel~o"]]);
    const again = await req(s, "panel~o", "releases.deploy", { part: "host" });
    expect(again).toEqual([{ type: "reply", id: "r", ok: true, result: { parts: { host: { from: "1.1.59", to: "1.1.59" } } }, to: "panel~o" }]);
    expect((await result(req(s, "~x", "releases.list", { part: "host" }))).rev).toBe(rev + 1);
  });

  it("2040 · deploy: вход отклонён — part не имя, версия не три числа, у «*» версии нет", async () => {
    const s = fresh();
    expect((await req(s, "~x", "releases.deploy", { part: "Ho st" }))[0]).toMatchObject({ error: "bad_frame" });
    expect((await req(s, "~x", "releases.deploy", {}))[0]).toMatchObject({ error: "bad_frame" });
    expect((await req(s, "~x", "releases.deploy", { part: "host", version: "1.5" }))[0]).toMatchObject({ error: "bad_version" });
    expect((await req(s, "~x", "releases.deploy", { part: "*", version: "1.1.1" }))[0]).toMatchObject({ error: "bad_frame" });
  });

  it("2041 · set: Host выключен силой и снова за stable; уже за stable — ok без плана; часть за stable — пустая запись; keeper закреплён и снят", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("host", "1.1.58");
    await inR2("keeper", "1.0.0", "1.0.1");
    await inR2("app", "1.0.0");
    for (const part of ["host", "keeper", "app"]) await req(s, "~x", "releases.deploy", { part });
    await req(s, ".keeper@laptop", "releases.plan");
    let rev = (await result(req(s, "~x", "releases.list", { part: "host" }))).rev;
    const off = await req(s, "~x", "releases.set", { machine: "laptop", part: "host", on: false, force: true });
    expect(off[0].result).toEqual({ machine: "laptop", rev: ++rev });
    expect(brief(plans(off)[0]).parts.find((p) => p.part === "host")).toEqual({ part: "host", version: "1.1.58", on: false, force: true });
    const on = await req(s, "~x", "releases.set", { machine: "laptop", part: "host", on: true });
    expect(on[0].result).toEqual({ machine: "laptop", rev: ++rev });
    expect(brief(plans(on)[0]).parts.find((p) => p.part === "host")).toEqual({ part: "host", version: "1.1.58" });
    const noop = await req(s, "~x", "releases.set", { machine: "laptop", part: "host", pin: null, on: true });
    expect(noop).toEqual([{ type: "reply", id: "r", ok: true, result: { machine: "laptop", rev }, to: "~x" }]);
    const app = await req(s, "~x", "releases.set", { machine: "laptop", part: "app" });
    expect(app[0].result).toEqual({ machine: "laptop", rev: ++rev });
    expect(brief(plans(app)[0]).parts.find((p) => p.part === "app")).toEqual({ part: "app", version: "1.0.0" });
    expect((await result(req(s, "~x", "releases.list", { part: "app" }))).machines).toEqual([{ machine: "laptop", plan: { app: {} } }]);
    const pin = await req(s, "~x", "releases.set", { machine: "laptop", part: "keeper", pin: "1.0.0" });
    expect(brief(plans(pin)[0]).parts[0]).toEqual({ part: "keeper", version: "1.0.0" });
    const unpin = await req(s, "~x", "releases.set", { machine: "laptop", part: "keeper", pin: null });
    expect(brief(plans(unpin)[0]).parts[0]).toEqual({ part: "keeper", version: "1.0.1" });
    expect((await result(req(s, "~x", "releases.list", { part: "keeper" }))).machines).toEqual([{ machine: "laptop", plan: {} }]);
  });

  it("2042 · set: вход отклонён — machine и part не имена, часть Cloudflare, pin не три числа, env не строки", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("app", "1.0.0");
    await req(s, "~x", "releases.deploy", { part: "app" });
    const bad = async (f: Record<string, unknown>) => (await req(s, "~x", "releases.set", f))[0];
    expect(await bad({ machine: "Win 1", part: "app" })).toMatchObject({ error: "bad_frame" });
    expect(await bad({ machine: "win", part: "A pp" })).toMatchObject({ error: "bad_frame" });
    expect(await bad({ machine: "win", part: "relay", on: false })).toMatchObject({ error: "bad_frame" });
    expect(await bad({ machine: "win", part: "app", pin: "1.0" })).toMatchObject({ error: "bad_version" });
    expect(await bad({ machine: "win", part: "app", env: { A: 1 } })).toMatchObject({ error: "bad_frame" });
    expect((await result(req(s, "~x", "releases.list", { part: "app" }))).machines).toEqual([]);
  });

  it("13 · план keeper — ровно поля v1: keeper заморожен с 1.0.0 и отказывает плану с чужим полем", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.4.0");
    await inR2("keeper", "0.5.0");
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    await req(s, "~x", "releases.set", { machine: "win", part: "capture", pin: "1.4.0", env: { SITE: "lab" } });
    const frame = plans(await req(s, "~x", "releases.set", { machine: "win", part: "capture", on: false, force: true }))[0];
    // конверт кадра (type, v, to, from) — протокол; тело плана — ровно поля v1
    expect(Object.keys(frame).sort()).toEqual(["from", "parts", "rev", "to", "type", "v"]);
    const answer = await result(req(s, ".keeper@win", "releases.plan"));
    expect(Object.keys(answer).sort()).toEqual(["parts", "rev"]);
    const v1 = ["env", "force", "on", "part", "sha256", "url", "version"];
    for (const p of [...(frame.parts as Array<Record<string, unknown>>), ...answer.parts]) expect(Object.keys(p).every((k) => v1.includes(k))).toBe(true);
    expect(Object.keys(answer.parts.find((p: { part: string }) => p.part === "capture")).sort()).toEqual(v1);
  });
});

describe("сборка Host «Выпусками»", () => {
  // источник всех эталонов блока: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): «Выпуски» собирают host —
  // текущая сборка + модуль, список внутри; проверка набора — check_failed с причинами; сборки — под именем флота
  const core = () => inCatalog("host", "1.2.0", { type: "sdk-core", provides: { "host.module": 1 }, uses: {}, config: {} });
  const mod = (name: string, version: string, x: Record<string, unknown> = {}) =>
    inCatalog(name, version, { type: "sdk", into: ["host"], provides: {}, uses: { "host.module@host": 1 }, config: {}, ...x });
  const buildOf = async (v: string) => {
    const o = await env.BUCKET.get(`test/host/${v}.tgz`);
    const files = entries(Buffer.from(await o!.arrayBuffer()));
    return { paths: files.map((x) => x.path), list: JSON.parse(files.find((x) => x.path === "build.json")!.data!.toString("utf8")) };
  };
  const setup = async () => {
    await workersIn({ push: {} });
    await inCatalog("push", "1.0.0", { type: "worker", provides: { "push.send": 1 }, uses: {}, config: {}, workers: { test: "switchboard-push" } });
    await core();
    await mod("host-watch", "1.0.0", { provides: { "session.watchers": 1 } });
    // библиотека — не часть флота, но владелец имени: её uses проверка находит в каталоге
    await inCatalog("release", "2.0.0", { type: "tool", provides: { "release.format": 1 }, uses: {}, config: {} });
    await mod("host-push", "3.0.0", { provides: { notify: 1 }, uses: { "host.module@host": 1, "session.watchers@host-watch": 1, "push.send@push": 1, "release.format@release": 1 } });
    await inR2("host", "1.1.85");
    await GATE.setHosts(["win", "wsl"]);
  };

  it("5117 · первая сборка: ядро и модули каталога с into host по зависимостям; build.json внутри; stable и план машин — сборка под именем флота", async () => {
    const s = fresh();
    await setup();
    // флот на прежней сборке Host монорепо (без «+»)
    await E.DB.exec(`UPDATE fleet SET stable = '{"host":"1.1.85"}' WHERE one = 1`);
    const out = await req(s, "agent~x", "releases.deploy", { part: "host-push" });
    expect(out[0].result).toEqual({ parts: { host: { from: "1.1.85", to: "1.2.0+1" } } });
    const b = await buildOf("1.2.0+1");
    expect(b.list).toEqual({ app: "host", version: "1.2.0+1", fleet: "test", modules: [{ name: "host-watch", version: "1.0.0" }, { name: "host-push", version: "3.0.0" }] });
    expect(b.paths).toEqual(["module.json", "build.json", "modules/", "modules/host-push/", "modules/host-push/module.json", "modules/host-watch/", "modules/host-watch/module.json"]);
    expect(plans(out).map((p) => [p.to, (p.parts as any[]).find((x) => x.part === "host").version])).toEqual([[".keeper@win", "1.2.0+1"], [".keeper@wsl", "1.2.0+1"]]);
    expect(((plans(out)[0].parts as any[]).find((x) => x.part === "host").url as string)).toContain("/switchboard-releases/test/host/1.2.0%2B1.tgz?");
    expect(out.filter((f) => f.type === "ledger.add").map((f) => f.text)).toEqual(["host 1.1.85 → 1.2.0+1 (host-push 3.0.0)"]);
  });

  it("5116 · «два владельца»: модуль со вторым владельцем имени — check_failed с причиной, stable и сборки прежние; исправленная версия — новая сборка", async () => {
    const s = fresh();
    await setup();
    await req(s, "~x", "releases.deploy", { part: "host-push" });
    await mod("host-dup", "1.0.0", { provides: { notify: 1 } });
    const log = journal();
    const bad = await req(s, "~x", "releases.deploy", { part: "host-dup" });
    expect(bad).toEqual([{ type: "reply", id: "r", ok: false, error: "check_failed", to: "~x" }]);
    expect(log).toContainEqual(expect.objectContaining({ word: "check_failed", why: expect.stringContaining("имя notify: два владельца") }));
    expect((await result(req(s, "~x", "releases.list", { part: "host" }))).parts.host).toEqual({ where: "machine", edge: "1.2.0+1", stable: "1.2.0+1" });
    await mod("host-dup", "1.0.1", { provides: { "dup.ping": 1 } });
    const good = await result(req(s, "~x", "releases.deploy", { part: "host-dup", version: "1.0.1" }));
    expect(good).toEqual({ parts: { host: { from: "1.2.0+1", to: "1.2.0+2" } } });
    expect((await buildOf("1.2.0+2")).list.modules.map((m: any) => `${m.name} ${m.version}`)).toEqual(["host-dup 1.0.1", "host-watch 1.0.0", "host-push 3.0.0"]);
  });

  it("5118 · два флота: сборки прода под prod/ не видны тестовому — номер и edge только своих; uses на Worker без владельца во флоте — check_failed", async () => {
    const s = fresh();
    await setup();
    await env.BUCKET.put("prod/host/1.2.0+7.tgz", "x");
    await env.BUCKET.put("prod/host/1.2.0+7.sha256", shaLine(sha256hex("x"), "1.2.0+7"));
    expect(await result(req(s, "~x", "releases.deploy", { part: "host-watch" }))).toEqual({ parts: { host: { from: null, to: "1.2.0+1" } } });
    expect((await result(req(s, "~x", "releases.list", { part: "host" }))).parts.host.edge).toBe("1.2.0+1");
    await mod("host-ghost", "1.0.0", { uses: { "ghost.call@ghost": 1 } });
    expect((await req(s, "~x", "releases.deploy", { part: "host-ghost" }))[0]).toMatchObject({ ok: false, error: "check_failed" });
  });

  it("5153 · модуль-Worker в каталоге, но во флоте не выложен (Cloudflare 10007) — list отдаёт его без версий, а не cf_failed", async () => {
    // источник: живой факт 2 нояб. — hello-worker снят, модуль остался в каталоге, releases.list отвечал cf_failed (flow-releases)
    const s = fresh();
    await fakeCf({ push: { tags: ["1.0.3"], live: "1.0.3" } });
    await inCatalog("ghost", "0.1.0", { type: "worker", provides: {}, uses: {}, config: {}, workers: { test: "switchboard-ghost" } });
    const l = await result(req(s, "~x", "releases.list"));
    expect(l.parts.ghost).toEqual({ where: "cloud", edge: null, stable: null });
    expect(l.parts.push).toEqual({ where: "cloud", edge: "1.0.3", stable: "1.0.3" });
  });

  it("5152 · в проверке набора приложение ОС — только выложенное: в плане машины его uses держат модуль сборки, вне плана — нет", async () => {
    // источник: дизайн «Открытый флот»: проверка — над выложенными сборками и частями флота; факт 2 нояб. — снять hello-host
    // мешал hello-daemon, уже снятый с машины
    const s = fresh();
    await setup();
    await mod("hello-host", "0.1.0", { provides: { "hello.ping": 1 } });
    await inCatalog("hello-daemon", "0.1.0", { type: "os", provides: {}, uses: { "hello.ping@hello-host": 1 }, config: {} });
    await req(s, "~x", "releases.deploy", { part: "hello-host" });
    await req(s, "~x", "releases.set", { machine: "win", part: "hello-daemon", pin: "0.1.0" });
    expect((await req(s, "~x", "releases.deploy", { part: "hello-host", version: null }))[0]).toMatchObject({ ok: false, error: "check_failed" });
    await req(s, "~x", "releases.set", { machine: "win", part: "hello-daemon", remove: true });
    expect((await result(req(s, "~x", "releases.deploy", { part: "hello-host", version: null }))).parts.host.to).toBe("1.2.0+2");
  });

  it("5119 · откат сборки: deploy host со сборкой «+n» или прежним архивом — stable на него без новой сборки; модуль с «+» — bad_version; version null — сборка без модуля", async () => {
    const s = fresh();
    await setup();
    await req(s, "~x", "releases.deploy", { part: "host-watch" });
    await mod("host-watch", "1.0.1", { provides: { "session.watchers": 1 } });
    await req(s, "~x", "releases.deploy", { part: "host-watch" });
    expect(await result(req(s, "~x", "releases.deploy", { part: "host", version: "1.2.0+1" }))).toEqual({ parts: { host: { from: "1.2.0+2", to: "1.2.0+1" } } });
    expect((await req(s, "~x", "releases.deploy", { part: "host-watch", version: "1.0.0+1" }))[0]).toMatchObject({ error: "bad_version" });
    // снять модуль: version null — сборка без него; не модуль сборки — bad_frame
    // без владельца чужого uses набор не проходит: host-push пользуется host-watch
    expect((await req(s, "~x", "releases.deploy", { part: "host-watch", version: null }))[0]).toMatchObject({ error: "check_failed" });
    expect(await result(req(s, "~x", "releases.deploy", { part: "host-push", version: null }))).toEqual({ parts: { host: { from: "1.2.0+1", to: "1.2.0+3" } } });
    expect((await buildOf("1.2.0+3")).list.modules).toEqual([{ name: "host-watch", version: "1.0.0" }]);
    expect((await req(s, "~x", "releases.deploy", { part: "push", version: null }))[0]).toMatchObject({ error: "bad_frame" });
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.2.0+1" });
    // прежний архив Host без манифеста — откат прямо на него
    expect(await result(req(s, "~x", "releases.deploy", { part: "host", version: "1.1.85" }))).toEqual({ parts: { host: { from: "1.2.0+1", to: "1.1.85" } } });
  });
});

describe("сборка страницы «Выпусками»", () => {
  it("5151 · выкладка модуля страницы: сборка пульта — оболочка, m/<модуль>.js и build.json с адресами флота от Cloudflare; версия Worker'а пульта со статикой, метка — номер сборки, выложена", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): «Выпуски» собирают версию Worker'а со
    // статикой и выкладывают; адреса relay и Worker'ов страница берёт из списка сборки
    const s = fresh();
    const put = async (name: string, version: string, manifest: Record<string, unknown>, extra: Array<[string, string]> = []) => {
      const tgz = pack([{ path: "module.json", data: Buffer.from(JSON.stringify({ name, version, provides: {}, uses: {}, config: {}, ...manifest })) }, ...extra.map(([path, d]) => ({ path, data: Buffer.from(d) }))]);
      await env.BUCKET.put(`${name}/${version}.tgz`, tgz);
      await env.BUCKET.put(`${name}/${version}.sha256`, shaLine(sha256hex(tgz), version));
    };
    await put("relay", "1.0.0", { type: "worker", provides: { roster: 1 }, workers: { test: "switchboard" } });
    await put("push", "1.0.0", { type: "worker", provides: { "push.send": 1 }, workers: { test: "switchboard-push" } });
    await put("pult", "1.1.0", { type: "web-app", workers: { test: "switchboard-pult" } }, [["index.html", "<!doctype html>"], ["_headers", "/build.json\n  Cache-Control: no-cache\n"]]);
    await put("web-core", "1.1.0", { type: "web", into: ["pult"], provides: { app: 1 } }, [["module.js", "export default {}"]]);
    await put("web-x", "1.0.0", { type: "web", into: ["pult"], uses: { "app@web-core": 1, "push.send@push": 1, "roster@relay": 1 } }, [["module.js", "export default {x:1}"]]);
    const tags: string[] = ["1.1.85"];
    let live = "v-1.1.85";
    const sent: { manifest?: Record<string, { hash: string }>; meta?: any; uploads: number } = { uploads: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const u = new URL(req.url);
      const p = u.pathname.replace("/client/v4/accounts/acc0", "");
      const ok = (result: unknown) => Response.json({ success: true, result });
      if (p === "/workers/assets/upload") return req.headers.get("authorization") === "Bearer up" ? (sent.uploads++, ok({ jwt: "done" })) : new Response(null, { status: 401 });
      if (req.headers.get("authorization") !== "Bearer test-token") return new Response(null, { status: 401 });
      if (p === "/workers/subdomain") return ok({ subdomain: "sub" });
      if (p === "/workers/domains") return ok(u.searchParams.get("service") === "switchboard" ? [{ hostname: "relay.example" }] : []);
      if (p === "/workers/scripts/switchboard-pult/assets-upload-session") {
        sent.manifest = ((await req.json()) as { manifest: Record<string, { hash: string }> }).manifest;
        return ok({ jwt: "up", buckets: [Object.values(sent.manifest).map((x) => x.hash)] });
      }
      if (p === "/workers/scripts/switchboard-pult/versions" && req.method === "POST") {
        sent.meta = JSON.parse(await ((await req.formData()).get("metadata") as Blob).text());
        tags.push(sent.meta.annotations["workers/tag"]);
        return ok({ id: `v-${tags.at(-1)}` });
      }
      if (p === "/workers/scripts/switchboard-pult/versions") return ok({ items: [...tags].reverse().map((t) => ({ id: `v-${t}`, annotations: { "workers/tag": t } })) });
      if (p === "/workers/scripts/switchboard-pult/deployments" && req.method === "POST") return (live = ((await req.json()) as any).versions[0].version_id), ok({});
      if (p === "/workers/scripts/switchboard-pult/deployments") return ok({ deployments: [{ versions: [{ version_id: live, percentage: 100 }] }] });
      return Response.json({ success: false, errors: [{ message: `нет ${p}` }] }, { status: 404 });
    });
    const out = await req(s, "agent~x", "releases.deploy", { part: "web-x" });
    expect(out[0].result).toEqual({ parts: { pult: { from: "1.1.85", to: "1.1.0+1" } } });
    expect(Object.keys(sent.manifest!).sort()).toEqual(["/build.json", "/index.html", "/m/web-core.js", "/m/web-x.js"]);
    expect(sent.uploads).toBe(1);
    expect(sent.meta).toMatchObject({ assets: { jwt: "done", config: { not_found_handling: "single-page-application", _headers: "/build.json\n  Cache-Control: no-cache\n" } }, annotations: { "workers/tag": "1.1.0+1" } });
    expect(live).toBe("v-1.1.0+1");
    const files = entries(Buffer.from(await (await env.BUCKET.get("test/pult/1.1.0+1.tgz"))!.arrayBuffer()));
    expect(JSON.parse(files.find((x) => x.path === "build.json")!.data!.toString("utf8"))).toEqual({
      app: "pult",
      version: "1.1.0+1",
      fleet: "test",
      modules: [{ name: "web-core", version: "1.1.0" }, { name: "web-x", version: "1.0.0" }],
      relay: "wss://relay.example",
      workers: { push: "https://switchboard-push.sub.workers.dev", relay: "https://relay.example" },
    });
    expect(out.filter((f) => f.type === "ledger.add").map((f) => f.text)).toEqual(["pult 1.1.85 → 1.1.0+1 (web-x 1.0.0)"]);
    // следующая сборка начинается со списка выложенной
    expect((await result(req(s, "agent~x", "releases.deploy", { part: "web-core" }))).parts.pult).toEqual({ from: "1.1.0+1", to: "1.1.0+2" });
  });

  it("5194 · снять модуль страницы: оболочка пользуется только ядром страницы — сборка без модуля проходит проверку", async () => {
    // источник: отчёт слепого архитектора 2 нояб.: пункт 4 — снять web-chat упиралось в uses оболочки (check_failed)
    const s = fresh();
    const put = async (name: string, version: string, manifest: Record<string, unknown>, extra: Array<[string, string]> = []) => {
      const tgz = pack([{ path: "module.json", data: Buffer.from(JSON.stringify({ name, version, provides: {}, uses: {}, config: {}, ...manifest })) }, ...extra.map(([path, d]) => ({ path, data: Buffer.from(d) }))]);
      await env.BUCKET.put(`${name}/${version}.tgz`, tgz);
      await env.BUCKET.put(`${name}/${version}.sha256`, shaLine(sha256hex(tgz), version));
    };
    await put("relay", "1.0.0", { type: "worker", provides: { roster: 1 }, workers: { test: "switchboard" } });
    await put("pult", "1.1.2", { type: "web-app", uses: { "app@web-core": 1 }, workers: { test: "switchboard-pult" } }, [["index.html", "<!doctype html>"]]);
    await put("web-core", "1.1.0", { type: "web", into: ["pult"], provides: { app: 1 } }, [["module.js", "export default {}"]]);
    await put("web-chat", "1.0.0", { type: "web", into: ["pult"], provides: { chat: 1 }, uses: { "app@web-core": 1 } }, [["module.js", "export default {}"]]);
    const tags: string[] = [];
    let live = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const u = new URL(req.url);
      const p = u.pathname.replace("/client/v4/accounts/acc0", "");
      const ok = (result: unknown) => Response.json({ success: true, result });
      if (p === "/workers/assets/upload") return ok({ jwt: "done" });
      if (p === "/workers/subdomain") return ok({ subdomain: "sub" });
      if (p === "/workers/domains") return ok([]);
      if (p.endsWith("/assets-upload-session")) return ok({ jwt: "up", buckets: [] });
      if (p.endsWith("/versions") && req.method === "POST") {
        tags.push(JSON.parse(await ((await req.formData()).get("metadata") as Blob).text()).annotations["workers/tag"]);
        return ok({ id: `v-${tags.at(-1)}` });
      }
      if (p.endsWith("/versions")) return ok({ items: [...tags].reverse().map((t) => ({ id: `v-${t}`, annotations: { "workers/tag": t } })) });
      if (p.endsWith("/deployments") && req.method === "POST") return (live = ((await req.json()) as any).versions[0].version_id), ok({});
      if (p.endsWith("/deployments")) return ok({ deployments: live ? [{ versions: [{ version_id: live, percentage: 100 }] }] : [] });
      return Response.json({ success: false, errors: [{ message: `нет ${p}` }] }, { status: 404 });
    });
    expect((await result(req(s, "~x", "releases.deploy", { part: "web-chat" }))).parts.pult.to).toBe("1.1.2+1");
    expect(await result(req(s, "~x", "releases.deploy", { part: "web-chat", version: null }))).toEqual({ parts: { pult: { from: "1.1.2+1", to: "1.1.2+2" } } });
    const files = entries(Buffer.from(await (await env.BUCKET.get("test/pult/1.1.2+2.tgz"))!.arrayBuffer()));
    expect(JSON.parse(files.find((x) => x.path === "build.json")!.data!.toString("utf8")).modules).toEqual([{ name: "web-core", version: "1.1.0" }]);
  });
});

describe("releases.fetch", () => {
  // источник всех эталонов блока: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): releases.fetch даёт ссылку
  // на чтение архива; другой репо берёт из каталога контракт и стенд
  it("5161 · без version — новейшая готовая версия каталога: ссылка GET на её архив на час", async () => {
    const s = fresh();
    await inCatalog("web-card", "1.0.0", { type: "web" });
    await inCatalog("web-card", "1.10.0", { type: "web" });
    await env.BUCKET.put("web-card/2.0.0.tgz", "без хэша — не готова");
    const r = await result(req(s, "repo~x", "releases.fetch", { part: "web-card" }));
    expect(r.version).toBe("1.10.0");
    expect(r.url).toMatch(/^https:\/\/acc0\.r2\.cloudflarestorage\.com\/switchboard-releases\/web-card\/1\.10\.0\.tgz\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Expires=3600&/);
  });

  it("5162 · с version — эта версия; нет такой версии или модуля — no_release", async () => {
    const s = fresh();
    await inCatalog("web-card", "1.0.0", { type: "web" });
    await inCatalog("web-card", "1.1.0", { type: "web" });
    expect((await result(req(s, "repo~x", "releases.fetch", { part: "web-card", version: "1.0.0" }))).url).toContain("/web-card/1.0.0.tgz?");
    expect((await req(s, "repo~x", "releases.fetch", { part: "web-card", version: "9.9.9" }))[0]).toMatchObject({ ok: false, error: "no_release" });
    expect((await req(s, "repo~x", "releases.fetch", { part: "nobody" }))[0]).toMatchObject({ ok: false, error: "no_release" });
  });

  it("5163 · сборка «+n» — не каталог: bad_version; имя не того вида — bad_frame", async () => {
    const s = fresh();
    expect((await req(s, "repo~x", "releases.fetch", { part: "host", version: "1.2.0+1" }))[0]).toMatchObject({ ok: false, error: "bad_version" });
    expect((await req(s, "repo~x", "releases.fetch", { part: "Bad Name" }))[0]).toMatchObject({ ok: false, error: "bad_frame" });
  });
});
