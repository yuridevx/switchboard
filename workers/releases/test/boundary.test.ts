// Леса границы «Каталог модулей», среда Worker'а: вход — Participant (привязка) и POST; снаружи — gate, relay, журнал, API Cloudflare.
// Проверка — наблюдаемый исход: ответ, кадры журнала и плана, строка флота, объекты R2, запросы к API. Номер — эталон-источник.
import { applyD1Migrations, createExecutionContext, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import { entries, pack, sha256hex, shaLine } from "@switchboard/release";
import { Participant } from "../src/index.ts";
import type { Deployed } from "../contract.ts";

/** Строки журнала releases, которые попали в console.log. */
function journal() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => {
    lines.push(JSON.parse(String(s)));
  });
  return lines;
}

type Env = Cloudflare.Env;
const participant = (exports as unknown as { default: { frame(f: Frame): Promise<Frame[]>; fetch(r: Request): Promise<Response> } }).default;
/** Вход со своим окружением: подмена привязок и счёт чтений. */
const frame = (e: Env, f: Frame) => new Participant(createExecutionContext(), e as never).frame(f);
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
 * Поддельный API Cloudflare: версии Worker'ов с метками, выложенные, адреса, загрузка статики. Записывает выкладки и то, что ушло страницей.
 * any — Worker без записи есть и пока без версий; иначе его нет (10007).
 */
function cloudflare(scripts: Record<string, { tags: string[]; live?: string }> = {}, o: { any?: boolean; domains?: Array<{ hostname: string; service: string }> } = {}) {
  const id = (s: string, tag: string) => `${s}-v${tag}`;
  const tags = new Map(Object.entries(scripts).map(([s, x]) => [s, [...x.tags]]));
  const live = new Map(Object.entries(scripts).map(([s, x]) => [s, x.live ? id(s, x.live) : null]));
  const deploys: Array<{ script: string; tag: string }> = [];
  const sent: { manifest?: Record<string, { hash: string; size: number }>; meta?: any; uploads: number; live: Map<string, string | null>; query?: string; perPage?: string | null; deployment?: unknown; files: Map<string, { type: string; data: string }> } = { uploads: 0, live, files: new Map() };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const p = new URL(req.url).pathname.replace("/client/v4/accounts/acc0", "");
    const ok = (result: unknown) => Response.json({ success: true, result });
    const token = req.headers.get("authorization");
    if (p === "/workers/assets/upload") {
      if (token !== "Bearer up") return new Response(null, { status: 401 });
      sent.uploads++;
      sent.query = new URL(req.url).search;
      for (const [hash, f] of (await req.formData()).entries()) sent.files.set(hash, { type: (f as unknown as File).type, data: atob(await (f as unknown as File).text()) });
      return ok({ jwt: "done" });
    }
    if (token !== "Bearer test-token") return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
    if (p === "/workers/subdomain") return ok({ subdomain: "sub" });
    if (p === "/workers/domains") return ok(o.domains ?? []);
    const m = /^\/workers\/scripts\/([^/]+)\/(assets-upload-session|versions|deployments)$/.exec(p);
    if (!m) return Response.json({ success: false, errors: [{ message: `нет ${p}` }] }, { status: 404 });
    const [, s, what] = m;
    if (!tags.has(s) && !o.any) return Response.json({ success: false, errors: [{ code: 10007, message: "no script" }] }, { status: 404 });
    if (what === "assets-upload-session") {
      sent.manifest = ((await req.json()) as { manifest: Record<string, { hash: string; size: number }> }).manifest;
      return ok({ jwt: "up", buckets: [Object.values(sent.manifest).map((x) => x.hash)] });
    }
    if (what === "versions" && req.method === "POST") {
      sent.meta = JSON.parse(await ((await req.formData()).get("metadata") as Blob).text());
      const tag = sent.meta.annotations["workers/tag"];
      tags.set(s, [...(tags.get(s) ?? []), tag]);
      return ok({ id: id(s, tag) });
    }
    if (what === "versions") sent.perPage = new URL(req.url).searchParams.get("per_page");
    if (what === "versions") return ok({ items: [...(tags.get(s) ?? [])].reverse().map((tag) => ({ id: id(s, tag), annotations: { "workers/tag": tag } })) });
    if (req.method === "POST") {
      sent.deployment = await req.json();
      const version = (sent.deployment as { versions: Array<{ version_id: string }> }).versions[0].version_id;
      live.set(s, version);
      deploys.push({ script: s, tag: version.slice(s.length + 2) });
      return ok({ id: "dep" });
    }
    return ok({ deployments: live.get(s) ? [{ versions: [{ version_id: live.get(s), percentage: 100 }] }] : [] });
  });
  return { deploys, sent };
}

/** Части Cloudflare: модули каталога с именами Worker'а по флотам и подделка API. Вид части «Выпуски» берут из каталога. */
async function fakeCf(parts: Record<string, { tags: string[]; live?: string }>) {
  await workersIn(parts);
  return cloudflare(Object.fromEntries(Object.entries(parts).map(([p, x]) => [scriptOf(p), x]))).deploys;
}

/** Модуль в каталоге с полями манифеста и файлами архива. */
async function put(name: string, version: string, manifest: Record<string, unknown>, extra: Array<[string, string]> = []) {
  const tgz = pack([{ path: "module.json", data: Buffer.from(JSON.stringify({ name, version, provides: {}, uses: {}, config: {}, ...manifest })) }, ...extra.map(([path, d]) => ({ path, data: Buffer.from(d) }))]);
  await env.BUCKET.put(`${name}/${version}.tgz`, tgz);
  await env.BUCKET.put(`${name}/${version}.sha256`, shaLine(sha256hex(tgz), version));
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
    expect((await result(req(s, "~x", "releases.list"))).machines).toEqual([]);
  });

  it("3 · 5071 · план спрашивает машина: POST пропуском машины (@win) и keeper кадром (.keeper@win); часть не keeper и клиент — bad_frame", async () => {
    const s = fresh();
    expect((await req(s, "@win", "releases.plan"))[0]).toMatchObject({ type: "reply", id: "r", ok: true, to: "@win" });
    expect((await req(s, ".host@win", "releases.plan"))[0]).toMatchObject({ ok: false, error: "bad_frame" });
    expect((await req(s, "panel~o", "releases.plan"))[0]).toMatchObject({ ok: false, error: "bad_frame" });
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

  it("6 · 2039 · deploy части машины: машины за stable получают план rev+1, закреплённая и машина без части — нет; строка журнала с by", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.3.2", "1.4.0");
    await inR2("host", "1.1.58", "1.1.59");
    await req(s, "~x", "releases.deploy", { part: "capture", version: "1.3.2" });
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.58" });
    await req(s, "~x", "releases.set", { machine: "pc2", part: "capture", pin: "1.3.2" });
    await req(s, "~x", "releases.set", { machine: "win", part: "capture" });
    await req(s, "~x", "releases.set", { machine: "wsl", part: "host", pin: "1.1.58" });
    // у laptop capture в плане нет — план ему не уходит
    await hosts("win", "pc2", "wsl", "laptop");
    const rev = (await result(req(s, "~x", "releases.list", { part: "capture" }))).rev;
    const out = await req(s, "panel~o", "releases.deploy", { part: "capture", version: "1.4.0" });
    expect(out[0].result).toEqual({ parts: { capture: { from: "1.3.2", to: "1.4.0" } } });
    expect(plans(out).map((f) => [f.to, f.rev, f.v])).toEqual([[".keeper@win", rev + 1, 1]]);
    expect(out.filter((f) => f.type === "ledger.add").map((f) => [f.ev, f.text, f.by])).toEqual([["part.deployed", "capture 1.3.2 → 1.4.0", "panel~o"]]);
    expect((await result(req(s, ".keeper@pc2", "releases.plan"))).parts.map((x: any) => [x.part, x.version])).toEqual([["host", "1.1.58"], ["capture", "1.3.2"]]);
    // host — у каждой машины за stable, кроме закреплённой
    const host = await req(s, "~x", "releases.deploy", { part: "host" });
    expect(plans(host).map((f) => [f.to, f.rev]).sort()).toEqual([[".keeper@laptop", rev + 2], [".keeper@pc2", rev + 2], [".keeper@win", rev + 2]]);
  });

  it("8 · 5144 · версия загружается один раз: новая — две ссылки; лежит — version_exists, с тем же хэшем — same; архив без хэша — ссылки снова", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): CI грузит модули запросом releases.upload —
    // повтор прогона с теми же модулями проходит; архив без хэша — версия не готова: факт — перезапуск CI №80 после обрыва
    const s = fresh();
    await inR2("capture", "1.4.0");
    const u = await result(req(s, "~x", "releases.upload", { part: "capture", version: "1.5.0" }));
    expect(u.tgz).toMatch(/^https:\/\/acc0\.r2\.cloudflarestorage\.com\/switchboard-releases\/capture\/1\.5\.0\.tgz\?.*X-Amz-Signature=/);
    expect(u.sha256).toMatch(/\/capture\/1\.5\.0\.sha256\?/);
    expect((await req(s, "~x", "releases.upload", { part: "capture", version: "1.4.0" }))[0]).toMatchObject({ ok: false, error: "version_exists" });
    const sha = sha256hex(tgzOf("capture", "1.4.0"));
    expect(await result(req(s, "~x", "releases.upload", { part: "capture", version: "1.4.0", sha256: sha }))).toEqual({ same: true });
    expect((await req(s, "~x", "releases.upload", { part: "capture", version: "1.4.0", sha256: "0".repeat(64) }))[0]).toMatchObject({ ok: false, error: "version_exists" });
    await env.BUCKET.put("capture/1.6.0.tgz", "half");
    expect((await result(req(s, "~x", "releases.upload", { part: "capture", version: "1.6.0", sha256: sha }))).tgz).toMatch(/\/capture\/1\.6\.0\.tgz\?/);
  });

  it("9 · 2041 · set: часть за stable — пустая запись; окружение, выключить силой и включить, закрепить и снять; уже так — ok с прежней rev без плана; убрать запись", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.4.0");
    await inR2("host", "1.1.58");
    await inR2("keeper", "0.5.0", "0.6.0");
    for (const part of ["capture", "host", "keeper"]) await req(s, "~x", "releases.deploy", { part });
    const at = (out: Frame[], part: string) => brief(plans(out)[0]).parts.find((p) => p.part === part);
    const set = (x: Record<string, unknown>) => req(s, "~x", "releases.set", { machine: "win", ...x });
    const add = await set({ part: "capture" });
    expect(add[0].result).toEqual({ machine: "win", rev: 4 });
    expect(at(add, "capture")).toEqual({ part: "capture", version: "1.4.0" });
    expect((await result(req(s, "~x", "releases.list", { part: "capture" }))).machines).toEqual([{ machine: "win", plan: { capture: {} } }]);
    // 3131 · снять окружение: rev +1, в плане часть без env; вернуть — снова в плане
    expect(at(await set({ part: "capture", env: { SITE: "lab" } }), "capture")).toEqual({ part: "capture", version: "1.4.0", env: { SITE: "lab" } });
    expect(at(await set({ part: "capture", env: {} }), "capture")).toEqual({ part: "capture", version: "1.4.0" });
    await set({ part: "capture", env: { SITE: "lab" } });
    const off = await set({ part: "capture", on: false, force: true });
    expect(plans(off).map((f) => [f.to, f.rev])).toEqual([[".keeper@win", 8]]);
    expect(at(off, "capture")).toEqual({ part: "capture", version: "1.4.0", on: false, force: true, env: { SITE: "lab" } });
    expect(await set({ part: "capture", on: false, force: true })).toEqual([{ type: "reply", id: "r", ok: true, result: { machine: "win", rev: 8 }, to: "~x" }]);
    // force false снимает силу, выключенной часть остаётся
    expect(at(await set({ part: "capture", force: false }), "capture")).toEqual({ part: "capture", version: "1.4.0", on: false, env: { SITE: "lab" } });
    expect(at(await set({ part: "capture", on: true }), "capture")).toEqual({ part: "capture", version: "1.4.0", env: { SITE: "lab" } });
    expect(at(await set({ part: "keeper", pin: "0.5.0" }), "keeper")).toEqual({ part: "keeper", version: "0.5.0" });
    expect((await set({ part: "keeper", pin: "0.9.0" }))[0]).toMatchObject({ error: "no_release" });
    expect(at(await set({ part: "keeper", pin: null }), "keeper")).toEqual({ part: "keeper", version: "0.6.0" });
    expect((await result(req(s, "~x", "releases.list", { part: "keeper" }))).machines).toEqual([{ machine: "win", plan: {} }]);
    // 3130 · убрать запись host — host снова за stable и в плане остаётся; убрать часть — её нет в плане; пустая запись машины не хранится
    await set({ part: "host", on: false });
    expect(at(await set({ part: "host", remove: true }), "host")).toEqual({ part: "host", version: "1.1.58" });
    expect(at(await set({ part: "capture", remove: true }), "capture")).toBeUndefined();
    expect((await result(req(s, "~x", "releases.list"))).machines).toEqual([]);
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
    // versions — номера части по порядку: «Выпуски» на странице закрепляют и возвращают любую из них
    expect(l.parts.host).toEqual({ where: "machine", edge: "1.1.58", stable: "1.1.57", versions: ["1.1.57", "1.1.58"] });
    expect(l.parts.capture).toEqual({ where: "machine", edge: "1.10.0", stable: null, versions: ["1.4.0", "1.10.0"] });
    expect(l.parts.relay).toEqual({ where: "cloud", edge: "1.1.60", stable: "1.1.58", versions: ["1.1.58", "1.1.60"] });
    expect(l.parts.pult).toEqual({ where: "cloud", edge: null, stable: null, versions: [] });
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
    // 3128 · 3133 · загрузка не дописана: версия без хэша не годится ни для выкладки, ни для закрепления, edge — последняя с хэшем
    await env.BUCKET.put("host/1.1.58.tgz", "half");
    expect((await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.58" }))[0]).toMatchObject({ ok: false, error: "no_release" });
    expect((await req(s, "~x", "releases.set", { machine: "win", part: "host", pin: "1.1.58" }))[0]).toMatchObject({ ok: false, error: "no_release" });
    const after = await result(req(s, "~x", "releases.list", { part: "host" }));
    expect([after.parts.host.stable, after.parts.host.edge, after.rev]).toEqual(["1.1.57", "1.1.57", 1]);
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

  it("2036 · list: API Cloudflare не ответил — cf_failed, статус и errors в журнале, без токена", async () => {
    const s = fresh();
    await workersIn(NONE);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 }));
    const log = journal();
    expect(await req(s, "~x", "releases.list")).toEqual([{ type: "reply", id: "r", ok: false, error: "cf_failed", why: "API Cloudflare ответил 403", to: "~x" }]);
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

  it.each([
    ["2094 · у Worker'а нет версии", { error: "no_release", why: "у points нет версии с меткой" }, { points: { tags: [] } }, (_u: string) => false],
  ])("4b · посреди «*»: %s — отказ словом, уже выложенные части Cloudflare в журнале флота, stable частей машины прежний", async (_n, word, over, broken) => {
    // источник: устав «система ловит»: отказ — словом, причина — в журнале; факт цикла тестов 2 нояб. — записи выложенных частей терялись
    const s = fresh();
    await fakeCf({ ...Object.fromEntries(Object.keys(NONE).map((k) => [k, { tags: ["1.1.58", "1.1.59"], live: "1.1.58" }])), ...over });
    await inR2("keeper", "1.0.1");
    await inR2("host", "1.1.57", "1.1.58");
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.57" });
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      broken(new Request(input, init).url) ? Response.json({ success: false, errors: [{ code: 10013 }] }, { status: 500 }) : real(input, init),
    );
    const out = await req(s, "~x", "releases.deploy", { part: "*" });
    expect(out[0]).toEqual({ type: "reply", id: "r", ok: false, ...word, to: "~x" });
    // порядок выкладки — части Cloudflare по имени, relay последним: до points выложены gate, github, ledger, phone
    expect(out.slice(1).map((f) => [f.type, f.to, f.text])).toEqual([
      ["ledger.add", ".ledger", "gate 1.1.58 → 1.1.59"],
      ["ledger.add", ".ledger", "github 1.1.58 → 1.1.59"],
      ["ledger.add", ".ledger", "ledger 1.1.58 → 1.1.59"],
      ["ledger.add", ".ledger", "phone 1.1.58 → 1.1.59"],
    ]);
    const row = await E.DB.prepare("SELECT stable, rev FROM fleet WHERE one = 1").first<{ stable: string; rev: number }>();
    expect([JSON.parse(row!.stable).host, row!.rev]).toEqual(["1.1.57", 1]);
  });

  it("5112 · вид части — из каталога: Worker — по workers.<FLEET> модуля, сборка Host и os — части машины, модуль Host частью не бывает", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): «Выпуски» знают свой флот одной строкой настройки, списков Worker'ов нет
    const s = fresh();
    await fakeCf({ push: { tags: ["1.0.3"], live: "1.0.3" } });
    await inCatalog("host-chat", "1.0.2", { type: "sdk", into: ["host"] });
    await inCatalog("capture", "2.0.0", { type: "os" });
    await inR2("host", "1.1.85");
    const l = await result(req(s, "~x", "releases.list"));
    expect(l.parts).toMatchObject({
      capture: { where: "machine", edge: "2.0.0", stable: null },
      host: { where: "machine", edge: "1.1.85", stable: null },
      push: { where: "cloud", edge: "1.0.3", stable: "1.0.3" },
    });
    expect(vi.mocked(fetch).mock.calls.map(([u]) => new URL(String(u)).pathname.split("/")[7])).toEqual(["switchboard-push", "switchboard-push"]);
    expect((await req(s, "~x", "releases.set", { machine: "win", part: "push", on: false }))[0]).toMatchObject({ error: "bad_frame" });
  });

  it.each<[string, string, Record<string, unknown>, string, string]>([
    ["2040 deploy: part не имя", "releases.deploy", { part: "Ho st" }, "bad_frame", "part — имя части или *"],
    ["2040 deploy: нет part", "releases.deploy", {}, "bad_frame", "part — имя части или *"],
    ["2040 deploy: версия не три числа", "releases.deploy", { part: "host", version: "1.5" }, "bad_version", "версия — три числа, сборка «+n» или null — снять модуль"],
    ["2040 deploy: у * версии нет", "releases.deploy", { part: "*", version: "1.1.1" }, "bad_frame", "у * версии нет: каждая часть — на свою edge"],
    ["deploy: без latest полей нет", "releases.deploy", { part: "host", without: ["x"] }, "bad_frame", "without и check_with — только вместе с latest: true"],
    ["deploy: without не список", "releases.deploy", { part: "host", latest: true, without: "x" }, "bad_frame", "without — список имён"],
    ["deploy: check_with не имена", "releases.deploy", { part: "host", latest: true, check_with: ["Не имя"] }, "bad_frame", "check_with — список имён"],
    ["deploy: latest не у сборки", "releases.deploy", { part: "app", latest: true }, "bad_frame", "latest: true — только у корня сборки или модуля сборки и без version"],
    ["deploy: снять не модуль", "releases.deploy", { part: "app", version: null }, "bad_frame", "app — не модуль сборки: снимать нечего"],
    ["2042 set: machine не имя", "releases.set", { machine: "Win 1", part: "app" }, "bad_frame", "machine — имя машины"],
    ["2042 set: part не имя", "releases.set", { machine: "win", part: "A pp" }, "bad_frame", "part — имя части машины"],
    ["2042 set: часть Cloudflare", "releases.set", { machine: "win", part: "relay", on: false }, "bad_frame", "part — имя части машины"],
    ["2042 set: pin не три числа", "releases.set", { machine: "win", part: "app", pin: "1.0" }, "bad_version", "pin — три числа или null"],
    ["2042 set: env не строки", "releases.set", { machine: "win", part: "app", env: { A: 1 } }, "bad_frame", "env — строки"],
    ["set: у keeper только pin", "releases.set", { machine: "win", part: "keeper", env: {} }, "bad_frame", "у keeper — только pin"],
    ["set: убрать то, чего нет", "releases.set", { machine: "win", part: "app", remove: true }, "no_part", "app нет в плане win"],
    ["set: новая часть без stable", "releases.set", { machine: "win", part: "probe", on: true }, "no_release", "у probe нет stable — закрепи версию"],
    ["upload: part не имя", "releases.upload", { part: "Cap ture", version: "1.5.0" }, "bad_frame", "part — имя части"],
    ["upload: версия не три числа", "releases.upload", { part: "capture", version: "1.5" }, "bad_version", "версия — три числа"],
    ["upload: хэш не того вида", "releases.upload", { part: "capture", version: "1.7.0", sha256: "abc" }, "bad_frame", "sha256 — хэш архива, 64 знака hex"],
    ["5163 fetch: имя не того вида", "releases.fetch", { part: "Bad Name" }, "bad_frame", "part — имя модуля"],
    ["5163 fetch: сборка «+n» — не каталог", "releases.fetch", { part: "host", version: "1.2.0+1" }, "bad_version", "версия каталога — три числа, без «+»"],
    ["5162 fetch: нет такой версии", "releases.fetch", { part: "app", version: "9.9.9" }, "no_release", "у app нет версии 9.9.9"],
    ["5162 fetch: нет модуля", "releases.fetch", { part: "nobody" }, "no_release", "у nobody нет версии в каталоге"],
  ])("вход отклонён, строка флота не тронута: %s", async (_n, type, f, word, why) => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("app", "1.0.0");
    await req(s, "~x", "releases.deploy", { part: "app" });
    const rev = (await result(req(s, "~x", "releases.list", { part: "app" }))).rev;
    expect((await req(s, "~x", type, f))[0]).toMatchObject({ ok: false, error: word, why });
    const l = await result(req(s, "~x", "releases.list", { part: "app" }));
    expect([l.rev, l.machines]).toEqual([rev, []]);
  });

  it("прямой вход: POST кадра с пропуском — ответ телом, машина спрашивает свой план; плохой пропуск — bad_key (чьё: код)", async () => {
    const post = (body: unknown) => participant.fetch(new Request("https://releases.test/", { method: "POST", body: JSON.stringify(body) }));
    const good = await (await post({ type: "releases.plan", v: 1, id: "p", key: "host.win.k1.s" })).json();
    expect(good).toMatchObject({ type: "reply", id: "p", ok: true, result: { rev: 0, parts: [] } });
    expect(await (await post({ type: "releases.plan", v: 1, id: "p", key: "host.win.k1.bad" })).json()).toMatchObject({ ok: false, error: "bad_key" });
    expect((await participant.fetch(new Request("https://releases.test/"))).status).toBe(404);
  });

  it("сосед молчит: relay не взял план, журнал не взял строку — выкладка состоялась, ответ ok, причина строкой (чьё: код)", async () => {
    await fakeCf(NONE);
    await inR2("host", "1.1.82");
    await hosts("win");
    const broken = new Proxy(E, {
      get: (o, k) => (k === "RELAY" ? { deliver: async () => { throw new Error("нет связи"); } } : k === "LEDGER" ? { frame: async () => { throw new Error("нет базы"); } } : Reflect.get(o, k)),
    }) as Env;
    const log = journal();
    const [r] = await frame(broken, { type: "releases.deploy", v: 1, id: "r", to: ".releases", from: "~x", part: "host" });
    expect(r).toMatchObject({ ok: true, result: { parts: { host: { from: null, to: "1.1.82" } } } });
    expect(log).toContainEqual(expect.objectContaining({ kind: "refuse", ev: "ledger.add", word: "offline", why: expect.stringContaining("host — → 1.1.82") }));
    expect(log).toContainEqual(expect.objectContaining({ kind: "refuse", ev: "releases.plan", word: "offline", why: expect.stringContaining("relay.deliver → .keeper@win") }));
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
    // API Cloudflare: адреса Worker'ов для списка сборки
    await fakeCf({});
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

  it("5117 · 5172 · первая сборка: ядро и модули каталога с into host по зависимостям; build.json внутри с адресами Worker'ов, которыми пользуется сборка; stable и план машин — сборка под именем флота", async () => {
    // 5172 — источник: отчёт слепого архитектора 2 нояб., пункт 1 (дубликат состояния: адреса Worker'ов у Host — из сборки, как у страниц)
    const s = fresh();
    await setup();
    // флот на прежней сборке Host монорепо (без «+»)
    await E.DB.exec(`UPDATE fleet SET stable = '{"host":"1.1.85"}' WHERE one = 1`);
    const out = await req(s, "agent~x", "releases.deploy", { part: "host-push" });
    expect(out[0].result).toEqual({ parts: { host: { from: "1.1.85", to: "1.2.0+1" } } });
    const b = await buildOf("1.2.0+1");
    // адреса Worker'ов, которыми пользуются модули сборки, — в списке сборки Host, как у страниц (5172)
    expect(b.list).toEqual({
      app: "host",
      version: "1.2.0+1",
      fleet: "test",
      modules: [{ name: "host-watch", version: "1.0.0" }, { name: "host-push", version: "3.0.0" }],
      workers: { push: "https://switchboard-push.sub.workers.dev" },
    });
    expect(b.paths).toEqual(["module.json", "build.json", "modules/", "modules/host-push/", "modules/host-push/module.json", "modules/host-watch/", "modules/host-watch/module.json"]);
    expect(plans(out).map((p) => [p.to, (p.parts as any[]).find((x) => x.part === "host").version])).toEqual([[".keeper@win", "1.2.0+1"], [".keeper@wsl", "1.2.0+1"]]);
    expect(((plans(out)[0].parts as any[]).find((x) => x.part === "host").url as string)).toContain("/switchboard-releases/test/host/1.2.0%2B1.tgz?");
    expect(out.filter((f) => f.type === "ledger.add").map((f) => f.text)).toEqual(["host 1.1.85 → 1.2.0+1 (host-push 3.0.0)"]);
  });

  it("gate молчит при новой сборке Host: отказ словом, архива и новой rev нет (спорное место)", async () => {
    const s = fresh();
    await setup();
    await req(s, "~x", "releases.deploy", { part: "host-watch" });
    const rev = (await result(req(s, "~x", "releases.list", { part: "host" }))).rev;
    await mod("host-watch", "1.0.1", { provides: { "session.watchers": 1 } });
    const silent = new Proxy(E, { get: (o, k) => (k === "GATE" ? { list: async () => { throw new Error("gate молчит"); } } : Reflect.get(o, k)) }) as Env;
    const [r] = await frame(silent, { type: "releases.deploy", v: 1, id: "r", to: ".releases", from: "~x", part: "host-watch" });
    expect(r).toMatchObject({ ok: false, error: "gate_unavailable" });
    expect(await env.BUCKET.get("test/host/1.2.0+2.tgz")).toBeNull();
    expect((await result(req(s, "~x", "releases.list", { part: "host" }))).rev).toBe(rev);
  });

  it("5116 · «два владельца»: модуль со вторым владельцем имени — check_failed с причиной, stable и сборки прежние; исправленная версия — новая сборка", async () => {
    const s = fresh();
    await setup();
    await req(s, "~x", "releases.deploy", { part: "host-push" });
    await mod("host-dup", "1.0.0", { provides: { notify: 1 } });
    const log = journal();
    const bad = await req(s, "~x", "releases.deploy", { part: "host-dup" });
    // 7306: причина в ответе, как обещает контракт releases.deploy (бэклог 3 нояб.: причину пришлось выводить из module.json)
    expect(bad).toEqual([{ type: "reply", id: "r", ok: false, error: "check_failed", why: expect.stringContaining("имя notify: два владельца"), to: "~x" }]);
    expect(log).toContainEqual(expect.objectContaining({ word: "check_failed", why: expect.stringContaining("имя notify: два владельца") }));
    expect((await result(req(s, "~x", "releases.list", { part: "host" }))).parts.host).toMatchObject({ where: "machine", edge: "1.2.0+1", stable: "1.2.0+1" });
    await mod("host-dup", "1.0.1", { provides: { "dup.ping": 1 } });
    const good = await result(req(s, "~x", "releases.deploy", { part: "host-dup", version: "1.0.1" }));
    expect(good).toEqual({ parts: { host: { from: "1.2.0+1", to: "1.2.0+2" } } });
    expect((await buildOf("1.2.0+2")).list.modules.map((m: any) => `${m.name} ${m.version}`)).toEqual(["host-dup 1.0.1", "host-watch 1.0.0", "host-push 3.0.0"]);
  });

  it("5118 · два флота: сборки прода под prod/ не видны тестовому — номер и edge только своих", async () => {
    const s = fresh();
    await setup();
    await env.BUCKET.put("prod/host/1.2.0+7.tgz", "x");
    await env.BUCKET.put("prod/host/1.2.0+7.sha256", shaLine(sha256hex("x"), "1.2.0+7"));
    expect(await result(req(s, "~x", "releases.deploy", { part: "host-watch" }))).toEqual({ parts: { host: { from: null, to: "1.2.0+1" } } });
    expect((await result(req(s, "~x", "releases.list", { part: "host" }))).parts.host.edge).toBe("1.2.0+1");
  });

  it("5153 · модуль-Worker в каталоге, но во флоте не выложен (Cloudflare 10007) — list отдаёт его без версий, а не cf_failed", async () => {
    // источник: живой факт 2 нояб. — hello-worker снят, модуль остался в каталоге, releases.list отвечал cf_failed (flow-releases)
    const s = fresh();
    await fakeCf({ push: { tags: ["1.0.3"], live: "1.0.3" } });
    await inCatalog("ghost", "0.1.0", { type: "worker", provides: {}, uses: {}, config: {}, workers: { test: "switchboard-ghost" } });
    const l = await result(req(s, "~x", "releases.list"));
    expect(l.parts.ghost).toMatchObject({ where: "cloud", edge: null, stable: null });
    expect(l.parts.push).toMatchObject({ where: "cloud", edge: "1.0.3", stable: "1.0.3" });
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
    await put("relay", "1.0.0", { type: "worker", provides: { roster: 1 }, workers: { test: "switchboard" } });
    await put("push", "1.0.0", { type: "worker", provides: { "push.send": 1 }, workers: { test: "switchboard-push" } });
    await put("pult", "1.1.0", { type: "web-app", workers: { test: "switchboard-pult" } }, [["index.html", "<!doctype html>"]]);
    // страница телефона — тоже адрес сборки, если модуль пользуется ею (слово пользователя 3 нояб.: ссылка приглашения на телефон)
    await put("phone", "1.0.0", { type: "web-app", provides: { page: 1 }, workers: { test: "switchboard-phone" } }, [["index.html", "<!doctype html>"]]);
    await put("web-core", "1.1.0", { type: "web", into: ["pult"], provides: { app: 1 } }, [["module.js", "export default {}"]]);
    await put("web-x", "1.0.0", { type: "web", into: ["pult"], uses: { "app@web-core": 1, "push.send@push": 1, "roster@relay": 1, "page@phone": 1 } }, [["module.js", "export default {x:1}"]]);
    const { sent } = cloudflare({ "switchboard-pult": { tags: ["1.1.85"], live: "1.1.85" } }, { any: true, domains: [{ hostname: "relay.example", service: "switchboard" }, { hostname: "other.example", service: "чужой" }] });
    const out = await req(s, "agent~x", "releases.deploy", { part: "web-x" });
    expect(out[0].result).toEqual({ parts: { pult: { from: "1.1.85", to: "1.1.0+1" } } });
    expect(Object.keys(sent.manifest!).sort()).toEqual(["/build.json", "/index.html", "/m/web-core.1.1.0.js", "/m/web-x.1.0.0.js"]);
    expect(sent.uploads).toBe(1);
    expect(sent.meta).toMatchObject({ assets: { jwt: "done", config: { _headers: "/m/*\n  Cache-Control: public, max-age=31536000, immutable\n/app.*.js\n  Cache-Control: public, max-age=31536000, immutable\n" } }, annotations: { "workers/tag": "1.1.0+1" } });
    expect(sent.live.get("switchboard-pult")).toBe("switchboard-pult-v1.1.0+1");
    // протокол Cloudflare, образец (опыт на старом коде, живой выпуск 2 нояб.): хэш файла — sha256 содержимого и расширения, 32 знака; файл — base64 в поле с именем хэша
    const js = sent.manifest!["/m/web-core.1.1.0.js"];
    expect(js).toEqual({ hash: "40f922fe9602d8787bc822dbc41435af", size: 17 });
    expect(sent.query).toBe("?base64=true");
    expect(sent.files.get(js.hash)).toEqual({ type: "application/javascript", data: "export default {}" });
    expect(sent.meta.compatibility_date).toBe("2026-10-01");
    expect(sent.deployment).toEqual({ strategy: "percentage", versions: [{ version_id: "switchboard-pult-v1.1.0+1", percentage: 100 }] });
    expect(sent.perPage).toBe("100");
    const files = entries(Buffer.from(await (await env.BUCKET.get("test/pult/1.1.0+1.tgz"))!.arrayBuffer()));
    expect(JSON.parse(files.find((x) => x.path === "build.json")!.data!.toString("utf8"))).toEqual({
      app: "pult",
      version: "1.1.0+1",
      fleet: "test",
      modules: [{ name: "web-core", version: "1.1.0" }, { name: "web-x", version: "1.0.0" }],
      workers: { push: "https://switchboard-push.sub.workers.dev", relay: "https://relay.example", phone: "https://switchboard-phone.sub.workers.dev" },
    });
    expect(out.filter((f) => f.type === "ledger.add").map((f) => f.text)).toEqual(["pult 1.1.85 → 1.1.0+1 (web-x 1.0.0)"]);
    // следующая сборка начинается со списка выложенной
    expect((await result(req(s, "agent~x", "releases.deploy", { part: "web-core" }))).parts.pult).toEqual({ from: "1.1.0+1", to: "1.1.0+2" });
    // index.html сборки — с картой импорта модулей (release 2.4.0): маячок домена её не опережает
    expect(files.find((x) => x.path === "index.html")!.data!.toString("utf8")).toContain('"@switchboard/web-x":"./m/web-x.1.0.0.js"');
    // list: модуль сборки — номер в выложенной сборке и новейший в каталоге; у пульта — история сборок
    await put("web-x", "1.1.0", { type: "web", into: ["pult"], uses: { "app@web-core": 1, "push.send@push": 1, "roster@relay": 1 } }, [["module.js", "export default {x:2}"]]);
    const l = await result(req(s, "agent~x", "releases.list"));
    expect(l.modules["web-x"]).toEqual({ into: ["pult"], built: { pult: "1.0.0" }, edge: "1.1.0" });
    expect(l.parts.pult.versions).toEqual(["1.1.0+1", "1.1.0+2"]);
    // вопрос об одной странице: та же строка, что в ответе о всём флоте
    expect((await result(req(s, "agent~x", "releases.list", { part: "pult" }))).parts.pult).toEqual(l.parts.pult);
    // 5717 · latest: все модули на новейшие одной сборкой — страница меняется разом (источник: переход фронта на React:
    // старые модули не стартуют с новым ядром, выкладка по модулю оставила бы страницу сломанной на всё время выкладки)
    // новая зависимость ядра входит в сборку, чужой модуль каталога с into — нет
    await put("web-dep", "1.0.0", { type: "web", into: ["pult"], provides: { dep: 1 } }, [["module.js", "export default {}"]]);
    await put("web-core", "1.2.0", { type: "web", into: ["pult"], provides: { app: 1 }, uses: { "dep@web-dep": 1 } }, [["module.js", "export default {}"]]);
    await put("hello-tab", "0.1.0", { type: "web", into: ["pult"], uses: { "нет@нет": 1 } }, [["module.js", "export default {}"]]);
    const uploads = sent.uploads;
    expect((await result(req(s, "agent~x", "releases.deploy", { part: "pult", latest: true }))).parts.pult).toEqual({ from: "1.1.0+2", to: "1.1.0+3" });
    expect(sent.uploads).toBe(uploads + 1);
    const third = entries(Buffer.from(await (await env.BUCKET.get("test/pult/1.1.0+3.tgz"))!.arrayBuffer()));
    expect(JSON.parse(third.find((x) => x.path === "build.json")!.data!.toString("utf8")).modules).toEqual([{ name: "web-dep", version: "1.0.0" }, { name: "web-core", version: "1.2.0" }, { name: "web-x", version: "1.1.0" }]);
    const refused = await req(s, "agent~x", "releases.deploy", { part: "нет-такого", latest: true });
    expect(refused[0]).toMatchObject({ ok: false, error: "bad_frame" });
  });

  it("статика Cloudflare: тип файла — по расширению, чужое — двоичное (опыт на старом коде: страница без типа не открывается)", async () => {
    const s = fresh();
    const shell: Array<[string, string]> = ["index.html", "a.png", "a.webmanifest", "a.css", "a.svg", "a.ico", "a.json", "a.txt"].map((f) => [f, f]);
    await put("pult", "1.0.0", { type: "web-app", workers: { test: "switchboard-pult" } }, shell);
    await put("web-core", "1.0.0", { type: "web", into: ["pult"], provides: { app: 1 } }, [["module.js", "export default {}"]]);
    const { sent } = cloudflare({}, { any: true });
    await result(req(s, "~x", "releases.deploy", { part: "web-core" }));
    const type = (path: string) => sent.files.get(sent.manifest![path].hash)!.type;
    expect(["/index.html", "/a.png", "/a.webmanifest", "/a.css", "/a.svg", "/a.ico", "/a.json", "/a.txt"].map(type)).toEqual([
      "text/html",
      "image/png",
      "application/manifest+json",
      "text/css",
      "image/svg+xml",
      "image/x-icon",
      "application/json",
      "application/octet-stream",
    ]);
  });

  it("7300 · latest у модуля: смена контракта, общего для двух приложений, выкладывается одной проверкой; порознь — отказ", async () => {
    // источник: факт 4 нояб. — app@web-core 1 → 2: пульт и телефон поодиночке дают check_failed, старая сборка соседа держит старый номер
    const s = fresh();
    const file = (name: string): Array<[string, string]> => [[name === "web-core" ? "module.js" : "index.html", "x"]];
    const scripts = { pult: { test: "switchboard-pult" }, phone: { test: "switchboard-phone" } };
    await put("pult", "1.0.0", { type: "web-app", uses: { "app@web-core": 1 }, workers: scripts.pult }, file("pult"));
    await put("phone", "1.0.0", { type: "web-app", uses: { "app@web-core": 1 }, workers: scripts.phone }, file("phone"));
    await put("web-core", "1.0.0", { type: "web", into: ["pult", "phone"], provides: { app: 1 } }, file("web-core"));
    cloudflare({}, { any: true });
    expect((await result(req(s, "agent~x", "releases.deploy", { part: "web-core", latest: true }))).parts).toMatchObject({ pult: { to: "1.0.0+1" }, phone: { to: "1.0.0+1" } });
    await put("pult", "2.0.0", { type: "web-app", uses: { "app@web-core": 2 }, workers: scripts.pult }, file("pult"));
    await put("phone", "2.0.0", { type: "web-app", uses: { "app@web-core": 2 }, workers: scripts.phone }, file("phone"));
    await put("web-core", "2.0.0", { type: "web", into: ["pult", "phone"], provides: { app: 2 } }, file("web-core"));
    // порознь — старая сборка соседа держит старый номер контракта
    expect((await req(s, "agent~x", "releases.deploy", { part: "pult", latest: true }))[0]).toMatchObject({ ok: false, error: "check_failed" });
    expect((await req(s, "agent~x", "releases.deploy", { part: "phone", latest: true }))[0]).toMatchObject({ ok: false, error: "check_failed" });
    // разом — одной проверкой
    const parts = (await result(req(s, "agent~x", "releases.deploy", { part: "web-core", latest: true }))).parts;
    expect(parts.pult.to).toBe("2.0.0+1");
    expect(parts.phone.to).toBe("2.0.0+1");
  });
});

describe("список выпусков в пределе чтения", () => {
  /** Env с подсчётом чтений хранилища и самых одновременных списков. */
  const counted = () => {
    const c = { reads: 0, inList: 0, maxList: 0 };
    const BUCKET = {
      get: (k: string, o?: R2GetOptions) => (c.reads++, E.BUCKET.get(k, o as never)),
      list: async (o?: R2ListOptions) => {
        c.reads++;
        c.maxList = Math.max(c.maxList, ++c.inList);
        // пауза держит запрос открытым: последовательный обход одновременности не даст
        await new Promise((r) => setTimeout(r, 5));
        c.inList--;
        return E.BUCKET.list(o);
      },
    };
    return { c, env: new Proxy(E, { get: (t, k) => (k === "BUCKET" ? BUCKET : Reflect.get(t, k)) }) as Env };
  };
  const listOf = async (e: Env, part?: string) => {
    const [r] = await frame(e, { type: "releases.list", v: 1, id: "r", to: ".releases", from: "~x", ...(part ? { part } : {}) });
    expect(r).toMatchObject({ type: "reply", ok: true });
    return r.result as any;
  };

  it("7344 · каталог не спрашивает службу пропусков: gate молчит — ответ целиком и о части", async () => {
    // источник: проход архитектора 4 нояб. — «медленный gate делает медленным каталог»; лишняя коммуникация по гейту
    await fakeCf({ push: { tags: ["1.0.0"], live: "1.0.0" } });
    await inCatalog("host", "1.2.0", { type: "sdk-core" });
    let asked = 0;
    const silent = new Proxy(E, { get: (t, k) => (k === "GATE" ? { list: () => (asked++, new Promise(() => {})) } : Reflect.get(t, k)) }) as Env;
    await listOf(silent);
    await listOf(silent, "host");
    expect(asked).toBe(0);
  });

  it("E7 · вопрос об одной части при 60 модулях: не больше 3 чтений хранилища, ответ тот же", async () => {
    // источник: факт — замер 2,5 с на одну часть при обходе всего хранилища
    await fakeCf({ push: { tags: ["1.0.0"], live: "1.0.0" } });
    await GATE.setHosts(["win"]);
    for (let i = 0; i < 60; i++) await inCatalog(`mod-${i}`, "1.0.0", { type: "sdk", into: ["host"] });
    await inCatalog("host", "1.2.0", { type: "sdk-core" });
    const tgz = tgzOf("host", "1.2.0+7");
    await env.BUCKET.put("test/host/1.2.0+7.tgz", tgz);
    await env.BUCKET.put("test/host/1.2.0+7.sha256", shaLine(sha256hex(tgz), "1.2.0+7"));
    await inR2("keeper", "1.1.4", "1.1.5");
    const host = counted();
    expect((await listOf(host.env, "host")).parts).toEqual({ host: { where: "machine", edge: "1.2.0+7", stable: null, versions: ["1.2.0+7"] } });
    expect(host.c.reads).toBeLessThanOrEqual(3);
    const keeper = counted();
    expect((await listOf(keeper.env, "keeper")).parts).toEqual({ keeper: { where: "machine", edge: "1.1.5", stable: null, versions: ["1.1.4", "1.1.5"] } });
    expect(keeper.c.reads).toBeLessThanOrEqual(3);
    const push = counted();
    const pushed = await listOf(push.env, "push");
    expect(pushed.parts.push).toMatchObject({ where: "cloud", edge: "1.0.0", stable: "1.0.0" });
    expect(pushed.machines).toEqual([]);
    expect(push.c.reads).toBeLessThanOrEqual(3);
    // той же формы, что и ответ о всём флоте
    const all = await listOf(E);
    expect(all.parts.keeper).toEqual({ where: "machine", edge: "1.1.5", stable: null, versions: ["1.1.4", "1.1.5"] });
  });

  it("хранилище отдаёт списки кусками: каталог и версии части обходятся до конца (чьё: код; лимит R2 — 1000 ключей на ответ)", async () => {
    await fakeCf({});
    for (let i = 0; i < 5; i++) await inCatalog(`mod-${i}`, "1.0.0", { type: "sdk", into: ["host"] });
    await inCatalog("host", "1.2.0", { type: "sdk-core" });
    await inR2("keeper", "1.0.0", "1.0.1", "1.0.2", "1.0.3");
    const BUCKET = { get: (k: string, o?: R2GetOptions) => E.BUCKET.get(k, o as never), list: (o?: R2ListOptions) => E.BUCKET.list({ ...o, limit: 2 }) };
    const pieces = new Proxy(E, { get: (t, k) => (k === "BUCKET" ? BUCKET : Reflect.get(t, k)) }) as Env;
    const l = await listOf(pieces);
    expect(Object.keys(l.modules).sort()).toEqual(["mod-0", "mod-1", "mod-2", "mod-3", "mod-4"]);
    expect(l.parts.keeper.versions).toEqual(["1.0.0", "1.0.1", "1.0.2", "1.0.3"]);
    expect((await listOf(pieces, "keeper")).parts.keeper.edge).toBe("1.0.3");
  });

  it("E7 · ответ о всём флоте: части читаются одновременно", async () => {
    // источник: замер 6,3 с и замечание архитектора: части машин читались по одной
    await fakeCf({});
    await inR2("host", "1.1.0");
    await inR2("keeper", "1.1.5");
    await inR2("capture", "1.0.0");
    const all = counted();
    await listOf(all.env);
    expect(all.c.maxList).toBeGreaterThan(1);
  });
});

describe("смена границы модулей: снять модуль и проверить вместе с новыми страницами", () => {
  // Манифесты — настоящие по именам и запросам: host-accounts, host-slots и их читатели в дереве на 4 нояб., host-logins из дизайна
  const LOGIN = { "machine.accounts": 1, "machine.login": 1, "machine.login_code": 1, "machine.account_remove": 1 };
  const SLOT = { "slot.set": 1, "slot.swap": 1, "session.slot": 1 };
  const setup = async () => {
    cloudflare({}, { any: true });
    const file = (m: Record<string, unknown>): Array<[string, string]> => [[m.type === "web-app" ? "index.html" : "module.js", "x"]];
    const place = (name: string, version: string, m: Record<string, unknown>) => put(name, version, m, file(m));
    const page = (name: string, version: string, owner: { accounts: string; slots: string; old: boolean }) =>
      place(name, version, {
        type: "web",
        into: ["pult", "phone"],
        uses: {
          "app@web-core": 1,
          ...Object.fromEntries(Object.keys(LOGIN).map((n) => [`${n}@${owner.accounts}`, 1])),
          ...Object.fromEntries(Object.keys(SLOT).map((n) => [`${n}@${owner.slots}`, 1])),
          ...(owner.old ? { "machine.slots@host-slots": 1 } : {}),
        },
      });
    await place("host", "1.2.22", { type: "sdk-core", provides: { "host.module": 1 } });
    await place("host-accounts", "2.1.0", { type: "sdk", into: ["host"], provides: { ...LOGIN, "account.usage": 1, "account.place": 2 }, uses: { "host.module@host": 1 } });
    await place("host-slots", "3.1.0", {
      type: "sdk",
      into: ["host"],
      provides: { "machine.slots": 1, ...SLOT, slot: 1, account: 1 },
      uses: { "host.module@host": 1, "machine.accounts@host-accounts": 1, "account.place@host-accounts": 2, "account.usage@host-accounts": 1 },
    });
    await place("host-remote", "1.1.0", { type: "sdk", into: ["host"], uses: { "host.module@host": 1, "account@host-slots": 1 } });
    await place("web-core", "3.0.0", { type: "web", into: ["pult", "phone"], provides: { app: 1 } });
    await page("pult-accounts", "3.1.1", { accounts: "host-accounts", slots: "host-slots", old: true });
    await place("pult", "2.1.0", { type: "web-app", workers: { test: "switchboard-pult" } });
    await place("phone", "2.1.0", { type: "web-app", workers: { test: "switchboard-phone" } });
    await GATE.setHosts(["win"]);
    const s = fresh();
    await result(req(s, "~x", "releases.deploy", { part: "host", latest: true }));
    await result(req(s, "~x", "releases.deploy", { part: "web-core", latest: true }));
    // новая граница: один модуль; прежние имена читателей — на него
    await place("host", "1.2.23", { type: "sdk-core", provides: { "host.module": 1 } });
    await place("host-logins", "1.0.0", { type: "sdk", into: ["host"], provides: { ...LOGIN, ...SLOT, slot: 1, account: 1 }, uses: { "host.module@host": 1 } });
    await place("host-remote", "1.2.0", { type: "sdk", into: ["host"], uses: { "host.module@host": 1, "account@host-logins": 1 } });
    await page("pult-accounts", "4.0.0", { accounts: "host-logins", slots: "host-logins", old: false });
    return s;
  };
  const modulesOf = async (key: string) => JSON.parse(entries(Buffer.from(await (await env.BUCKET.get(key))!.arrayBuffer())).find((x) => x.path === "build.json")!.data!.toString("utf8")).modules.map((m: { name: string }) => m.name);

  it("E38 · с without и check_with Host выкладывается один раз, страницы — следом; без полей check_failed", async () => {
    // источник: факт — прогон проверки на настоящих манифестах: 8, 4 и 7 ошибок порознь, 0 одной проверкой
    const s = await setup();
    // два владельца: старые модули остались в сборке рядом с новым
    expect((await req(s, "~x", "releases.deploy", { part: "host", latest: true }))[0]).toMatchObject({ ok: false, error: "check_failed" });
    // старые модули сняты, но страницы всё ещё называют их владельцами
    expect((await req(s, "~x", "releases.deploy", { part: "host", latest: true, without: ["host-slots", "host-accounts"] }))[0]).toMatchObject({ ok: false, error: "check_failed" });
    // только check_with: снова два владельца
    expect((await req(s, "~x", "releases.deploy", { part: "host", latest: true, check_with: ["pult", "phone"] }))[0]).toMatchObject({ ok: false, error: "check_failed" });
    const out = await req(s, "~x", "releases.deploy", { part: "host", latest: true, without: ["host-slots", "host-accounts"], check_with: ["pult", "phone"] });
    expect(out[0]).toMatchObject({ ok: true, result: { parts: { host: { to: "1.2.23+1" } } } });
    const mods = await modulesOf("test/host/1.2.23+1.tgz");
    expect(mods).toContain("host-logins");
    expect(mods).not.toContain("host-slots");
    expect(mods).not.toContain("host-accounts");
    // страницы не выложены: проверялись, но не собирались
    expect((out[0].result as Deployed).parts).not.toHaveProperty("pult");
    expect(await modulesOf("test/pult/2.1.0+1.tgz")).toContain("pult-accounts");
    expect(await env.BUCKET.get("test/pult/2.1.0+2.tgz")).toBeNull();
    expect(plans(out).map((f) => f.to)).toEqual([".keeper@win"]);
    expect(out.filter((f) => f.type === "ledger.add").map((f) => f.text)).toEqual(["host 1.2.22+1 → 1.2.23+1 (host 1.2.23; сняты host-slots, host-accounts)"]);
    // страницы следом: Host уже новый, одна обычная выкладка
    const pages = await req(s, "~x", "releases.deploy", { part: "pult-accounts", latest: true });
    expect(pages[0]).toMatchObject({ ok: true, result: { parts: { pult: { to: "2.1.0+2" }, phone: { to: "2.1.0+2" } } } });
    // чужое приложение — no_build; снять корень — bad_frame; откат номером идёт мимо проверки (чьё: код)
    expect((await req(s, "~x", "releases.deploy", { part: "host", latest: true, check_with: ["no-app"] }))[0]).toMatchObject({ ok: false, error: "no_build" });
    expect((await req(s, "~x", "releases.deploy", { part: "host", latest: true, without: ["host"] }))[0]).toMatchObject({ ok: false, error: "bad_frame" });
    expect((await result(req(s, "~x", "releases.deploy", { part: "host", version: "1.2.22+1" }))).parts.host).toEqual({ from: "1.2.23+1", to: "1.2.22+1" });
  });
});

describe("сверка со старым кодом", () => {
  const set = (s: Stub, x: Record<string, unknown>) => req(s, "~x", "releases.set", { machine: "win", ...x });
  const built = async (key: string) => JSON.parse(entries(Buffer.from(await (await env.BUCKET.get(key))!.arrayBuffer())).find((x) => x.path === "build.json")!.data!.toString("utf8"));

  it("on: true снимает и силу: следующий on: false остановит часть штатно (чьё: код)", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.4.0");
    await req(s, "~x", "releases.deploy", { part: "capture" });
    await set(s, { part: "capture", on: false, force: true });
    await set(s, { part: "capture", on: true });
    expect((await result(req(s, "~x", "releases.list", { part: "capture" }))).machines).toEqual([{ machine: "win", plan: { capture: {} } }]);
    expect(brief(plans(await set(s, { part: "capture", on: false }))[0]).parts.find((p) => p.part === "capture")).toEqual({ part: "capture", version: "1.4.0", on: false });
    // on: true вместе с force — сила остаётся: её просили этим же кадром
    await set(s, { part: "capture", on: true, force: true });
    expect((await result(req(s, "~x", "releases.list", { part: "capture" }))).machines[0].plan.capture).toEqual({ force: true });
  });

  it("снять закрепление у части без stable — no_release: запись без версии убрала бы часть с машины (чьё: код)", async () => {
    const s = fresh();
    await fakeCf(NONE);
    await inR2("capture", "1.4.0");
    await set(s, { part: "capture", pin: "1.4.0" });
    expect((await set(s, { part: "capture", pin: null }))[0]).toMatchObject({ ok: false, error: "no_release", why: "у capture нет stable — закрепи версию" });
    expect((await result(req(s, ".keeper@win", "releases.plan"))).parts.map((x: any) => [x.part, x.version])).toEqual([["capture", "1.4.0"]]);
  });

  it("модуль в приложение, которого нет в каталоге, — no_build словом (чьё: код)", async () => {
    const s = fresh();
    cloudflare({}, { any: true });
    await put("web-y", "1.0.0", { type: "web", into: ["ghost"] }, [["module.js", "x"]]);
    expect((await req(s, "~x", "releases.deploy", { part: "web-y" }))[0]).toMatchObject({ ok: false, error: "no_build" });
    expect((await req(s, "~x", "releases.deploy", { part: "web-y", latest: true }))[0]).toMatchObject({ ok: false, error: "no_build" });
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
    // 5162 · с version — эта версия
    expect((await result(req(s, "repo~x", "releases.fetch", { part: "web-card", version: "1.0.0" }))).url).toContain("/web-card/1.0.0.tgz?");
  });
});
