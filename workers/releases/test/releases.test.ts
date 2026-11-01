import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import { presign, sha256hex, shaLine } from "@switchboard/release";

const participant = (exports as unknown as { default: { hello(): Promise<unknown>; frame(f: Frame): Promise<void> } }).default;
type Stub = DurableObjectStub & { frame(f: Frame): Promise<Frame[]> };
let n = 0;
const fresh = () => env.RELEASES.get(env.RELEASES.idFromName(`t-${++n}-${Math.random()}`)) as unknown as Stub;

/** Поддельный API Cloudflare: версии Worker'ов с метками, выложенная версия; записывает выкладки. */
function fakeCf(parts: Record<string, { tags: string[]; live?: string }>) {
  const scripts = Object.fromEntries(Object.entries(parts).map(([p, x]) => [env.CLOUD[p], x]));
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

/** Готовая версия части машины в R2: архив и хэш. */
async function inR2(part: string, ...vs: string[]) {
  for (const v of vs) {
    await env.BUCKET.put(`${part}/${v}.tgz`, `${part} ${v}`);
    await env.BUCKET.put(`${part}/${v}.sha256`, shaLine(sha256hex(`${part} ${v}`), v));
  }
}

const req = (s: Stub, from: string, type: string, extra: Record<string, unknown> = {}) => s.frame({ type, id: "r", to: ".releases", from, ...extra });
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
  await env.RELAY_LOG.take();
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны releases", () => {
  it("1 · подпись ссылки — пример AWS: GET test.txt на сутки", async () => {
    const url = await presign(
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
      { method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", now: new Date("2013-05-24T00:00:00Z"), expires: 86400 },
    );
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("2 · первый вопрос keeper: план пустой — keeper и host за stable, ссылка на час, машина в списке", async () => {
    const s = fresh();
    fakeCf(NONE);
    await inR2("host", "1.1.57");
    await inR2("keeper", "0.5.0");
    await req(s, "~x", "releases.deploy", { part: "host" });
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    const p = await result(req(s, ".keeper@win", "releases.plan"));
    expect(p.rev).toBe(2);
    expect(p.parts.map((x: any) => [x.part, x.version, x.sha256])).toEqual([
      ["keeper", "0.5.0", sha256hex("keeper 0.5.0")],
      ["host", "1.1.57", sha256hex("host 1.1.57")],
    ]);
    expect(p.parts[1].url).toMatch(/^https:\/\/acc0\.r2\.cloudflarestorage\.com\/switchboard-releases\/host\/1\.1\.57\.tgz\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AK%2F\d{8}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=\d{8}T\d{6}Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/);
    expect((await result(req(s, "~x", "releases.list"))).machines).toEqual([{ machine: "win", plan: {} }]);
  });

  it("3 · план спрашивает только keeper: Host машины и клиент — bad_frame", async () => {
    const s = fresh();
    expect(await req(s, "@win", "releases.plan")).toEqual([{ type: "reply", id: "r", ok: false, error: "bad_frame", to: "@win" }]);
    expect((await req(s, ".host@win", "releases.plan"))[0]).toMatchObject({ ok: false, error: "bad_frame" });
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
    const deploys = fakeCf({
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
    expect(out.filter((f) => f.type === "ledger.add").map((f) => [f.ev, f.text, f.by])).toEqual([
      ["part.deployed", "host 1.1.57 → 1.1.58", "~yuri"],
      ["part.deployed", "relay 1.1.57 → 1.1.58", "~yuri"],
    ]);
    expect(deploys).toEqual([{ script: "switchboard", tag: "1.1.58" }]);
  });

  it("4b · Cloudflare отказал посреди «*»: stable частей машины прежний; повтор с исправным Cloudflare — план keeper с новой rev", async () => {
    const s = fresh();
    fakeCf(NONE);
    await inR2("host", "1.1.57", "1.1.58");
    await inR2("keeper", "0.5.0");
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.57" });
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    await req(s, ".keeper@win", "releases.plan");
    // у gate версия есть, у github — нет: отказ на второй части Cloudflare
    fakeCf({ ...NONE, gate: { tags: ["1.1.58"], live: "1.1.57" } });
    expect((await req(s, "~x", "releases.deploy", { part: "*" }))[0]).toMatchObject({ ok: false, error: "no_release" });
    expect((await result(req(s, "~x", "releases.list", { part: "host" }))).parts.host.stable).toBe("1.1.57");
    fakeCf(Object.fromEntries(Object.keys(NONE).map((k) => [k, { tags: ["1.1.58"], live: "1.1.58" }])));
    const out = await req(s, "~x", "releases.deploy", { part: "*" });
    expect((out[0].result as any).parts.host).toEqual({ from: "1.1.57", to: "1.1.58" });
    expect(plans(out).map(brief)).toEqual([{ to: ".keeper@win", rev: 3, parts: [{ part: "keeper", version: "0.5.0" }, { part: "host", version: "1.1.58" }] }]);
  });

  it("5 · откат Worker одним вызовом: одна выкладка в Cloudflare, планы машин не меняются", async () => {
    const s = fresh();
    const deploys = fakeCf({ ...NONE, relay: { tags: ["1.1.58", "1.1.59", "1.1.60"], live: "1.1.60" } });
    await req(s, ".keeper@win", "releases.plan");
    const out = await req(s, "~x", "releases.deploy", { part: "relay", version: "1.1.58" });
    expect(out[0].result).toEqual({ parts: { relay: { from: "1.1.60", to: "1.1.58" } } });
    expect(deploys).toEqual([{ script: "switchboard", tag: "1.1.58" }]);
    expect(plans(out)).toEqual([]);
  });

  it("6 · закреплённая не следует за stable: pin 1.3.2 у pc2, deploy capture 1.4.0 — план pc2 не меняется", async () => {
    const s = fresh();
    fakeCf(NONE);
    await inR2("capture", "1.3.2", "1.4.0");
    await req(s, "~x", "releases.deploy", { part: "capture", version: "1.3.2" });
    await req(s, "~x", "releases.set", { machine: "pc2", part: "capture", pin: "1.3.2" });
    await req(s, "~x", "releases.set", { machine: "win", part: "capture" });
    const out = await req(s, "~x", "releases.deploy", { part: "capture", version: "1.4.0" });
    expect(plans(out).map((f) => f.to)).toEqual([".keeper@win"]);
    expect((await result(req(s, ".keeper@pc2", "releases.plan"))).parts.map((x: any) => x.version)).toEqual(["1.3.2"]);
  });

  it("7 · машина вернулась на связь: при подключении keeper получает план с новой stable", async () => {
    const s = fresh();
    fakeCf(NONE);
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
    expect((await req(s, "~x", "releases.upload", { part: "relay", version: "1.5.0" }))[0]).toMatchObject({ error: "bad_frame" });
  });

  it("9 · set: выключить силой, окружение, снять; у keeper только pin; уже так — ok с прежней rev", async () => {
    const s = fresh();
    fakeCf(NONE);
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
    fakeCf({ ...NONE, relay: { tags: ["1.1.58", "1.1.60"], live: "1.1.58" } });
    await inR2("host", "1.1.57", "1.1.58");
    await inR2("capture", "1.4.0", "1.10.0");
    await req(s, "~x", "releases.deploy", { part: "host", version: "1.1.57" });
    await req(s, "~x", "releases.set", { machine: "pc2", part: "capture", pin: "1.4.0" });
    const l = await result(req(s, "~x", "releases.list"));
    expect(l.parts.host).toEqual({ where: "machine", edge: "1.1.58", stable: "1.1.57" });
    expect(l.parts.capture).toEqual({ where: "machine", edge: "1.10.0", stable: null });
    expect(l.parts.relay).toEqual({ where: "cloud", edge: "1.1.60", stable: "1.1.58" });
    expect(l.parts.pult).toEqual({ where: "cloud", edge: null, stable: null });
    expect(l.machines).toEqual([{ machine: "pc2", plan: { capture: { pin: "1.4.0" } } }]);
    expect(Object.keys((await result(req(s, "~x", "releases.list", { part: "host" }))).parts)).toEqual(["host"]);
  });

  it("11 · Cloudflare отказал — cf_failed; неизвестный запрос — unknown_request; нет версии — no_release", async () => {
    const s = fresh();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 }));
    expect((await req(s, "~x", "releases.deploy", { part: "relay" }))[0]).toMatchObject({ ok: false, error: "cf_failed" });
    expect((await req(s, "~x", "releases.nope"))[0]).toMatchObject({ ok: false, error: "unknown_request" });
    expect((await req(s, "~x", "releases.deploy", { part: "host", version: "9.9.9" }))[0]).toMatchObject({ ok: false, error: "no_release" });
  });

  it("12 · участник: hello — контракт; ответ и план keeper уходят через свою привязку RELAY", async () => {
    expect(await participant.hello()).toEqual({ contract: { "releases.plan": 1, "releases.list": 1, "releases.upload": 1, "releases.deploy": 1, "releases.set": 1 } });
    await participant.frame({ type: "releases.plan", id: "q", to: ".releases", from: ".keeper@box" });
    const sent = await env.RELAY_LOG.take();
    expect(sent.map((x) => [x.name, x.frame.type, x.frame.to])).toEqual([["releases", "reply", ".keeper@box"]]);
  });

  it("13 · план keeper — ровно поля v1: keeper заморожен с 1.0.0 и отказывает плану с чужим полем", async () => {
    const s = fresh();
    fakeCf(NONE);
    await inR2("capture", "1.4.0");
    await inR2("keeper", "0.5.0");
    await req(s, "~x", "releases.deploy", { part: "keeper" });
    await req(s, "~x", "releases.set", { machine: "win", part: "capture", pin: "1.4.0", env: { SITE: "lab" } });
    const frame = plans(await req(s, "~x", "releases.set", { machine: "win", part: "capture", on: false, force: true }))[0];
    expect(Object.keys(frame).sort()).toEqual(["parts", "rev", "to", "type", "v"]);
    const answer = await result(req(s, ".keeper@win", "releases.plan"));
    expect(Object.keys(answer).sort()).toEqual(["parts", "rev"]);
    const v1 = ["env", "force", "on", "part", "sha256", "url", "version"];
    for (const p of [...(frame.parts as Array<Record<string, unknown>>), ...answer.parts]) expect(Object.keys(p).every((k) => v1.includes(k))).toBe(true);
    expect(Object.keys(answer.parts.find((p: { part: string }) => p.part === "capture")).sort()).toEqual(v1);
  });
});
