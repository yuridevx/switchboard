import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import wrangler from "../wrangler.jsonc?raw";
import manifest from "../module.json" with { type: "json" };
import type { Stored } from "../src/app.ts";
import { pkcs8 } from "../src/jwt.ts";

const relay = (exports as unknown as { default: { hello(): Promise<unknown>; frame(f: Frame): Promise<void> } }).default;
type Stub = DurableObjectStub & { frame(f: Frame): Promise<Frame[]> };
let n = 0;
const fresh = () => env.APP.get(env.APP.idFromName(`t-${++n}-${Math.random()}`)) as unknown as Stub;
const home = () => env.APP.get(env.APP.idFromName("home")) as unknown as Stub;

const INSTALL = "https://github.com/apps/switchboard-team/installations/new";
let pem = "";
let pub: CryptoKey;

/** Ключ приложения теста в PKCS#1 — как его отдаёт GitHub. */
beforeAll(async () => {
  const k = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  pub = k.publicKey;
  const p8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", k.privateKey)) as ArrayBuffer);
  // PrivateKeyInfo 2048 бит: 30 82 xx xx | 02 01 00 | 30 0d …(15) | 04 82 xx xx | PKCS#1
  expect([p8[0], p8[4], p8[7], p8[22]]).toEqual([0x30, 0x02, 0x30, 0x04]);
  const p1 = p8.slice(26);
  let s = "";
  for (const b of p1) s += String.fromCharCode(b);
  pem = `-----BEGIN RSA PRIVATE KEY-----\n${btoa(s).replace(/.{64}/g, "$&\n")}\n-----END RSA PRIVATE KEY-----\n`;
  expect(pkcs8(pem)).toEqual(p8);
});

const APP = (): Stored => ({ id: 1047113, slug: "switchboard-team", owner: "team", pem, at: 1793457720000, by: "panel" });
const seed = (s: Stub, app: Stored = APP()) => runInDurableObject(s, (_o, st) => st.storage.put("app", app));
const stored = (s: Stub) => runInDurableObject(s, (_o, st) => st.storage.get<Stored>("app"));

type Call = { method: string; path: string; auth: string | null; body: unknown };

/** Поддельный GitHub: маршрут «МЕТОД путь» → [статус, тело]. */
function fakeGithub(routes: Record<string, [number, unknown]>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    const call = { method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    expect(url.origin).toBe("https://api.github.com");
    expect(req.headers.get("user-agent")).toBeTruthy();
    const r = routes[`${call.method} ${call.path}`] ?? routes[`${call.method} ${url.pathname}`];
    if (!r) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(r[1]), { status: r[0] });
  });
  return calls;
}

function journal() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => {
    lines.push(String(s));
  });
  return lines;
}

const b64uJson = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));

async function verifyJwt(auth: string | null) {
  const [head, body, sig] = (auth ?? "").replace(/^Bearer /, "").split(".");
  const raw = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, raw, new TextEncoder().encode(`${head}.${body}`));
  return { good, head: b64uJson(head), claims: b64uJson(body) };
}

beforeEach(async () => {
  await env.RELAY_LOG.take();
  await env.RELAY_LOG.answer();
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны github", () => {
  it("240 · github.token: JWT с iss 1047113 → установка 58203311 → токен на profiles с contents: write; хранилище не изменилось", async () => {
    const s = fresh();
    await seed(s);
    const calls = fakeGithub({
      "GET /repos/team/profiles/installation": [200, { id: 58203311, account: { login: "team" } }],
      "POST /app/installations/58203311/access_tokens": [201, { token: "ghs_test", expires_at: "2026-10-31T13:02:11Z" }],
    });
    const out = await s.frame({ type: "github.token", id: "t-9", v: 1, to: "github", from: "@laptop", repo: "team/profiles" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/team/profiles/installation", "POST /app/installations/58203311/access_tokens"]);
    const jwt = await verifyJwt(calls[0].auth);
    expect(jwt.good).toBe(true);
    expect(jwt.head.alg).toBe("RS256");
    expect(jwt.claims.iss).toBe("1047113");
    expect(jwt.claims.exp - jwt.claims.iat).toBeLessThanOrEqual(600);
    expect(calls[1].body).toEqual({ repositories: ["profiles"], permissions: { contents: "write" } });
    expect(out).toEqual([{ type: "reply", id: "t-9", ok: true, to: "@laptop", result: { token: "ghs_test", expires_at: "2026-10-31T13:02:11Z" } }]);
    expect(await stored(s)).toEqual(APP());
  });

  it("241 · хранилище пусто: github.token — no_app, GitHub не вызван, строка журнала со словом и from", async () => {
    const s = fresh();
    const calls = fakeGithub({});
    const log = journal();
    expect(await s.frame({ type: "github.token", id: "t-1", to: "github", from: "@laptop", repo: "team/profiles" })).toEqual([
      { type: "reply", id: "t-1", ok: false, error: "no_app", to: "@laptop" },
    ]);
    expect(calls).toHaveLength(0);
    expect(log.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ part: "github", word: "no_app", from: "@laptop" }));
  });

  it("242 · установки у team/wiki нет (404): not_installed со ссылкой установки, токен не запрашивался", async () => {
    const s = fresh();
    await seed(s);
    const calls = fakeGithub({ "POST /app/installations/58203311/access_tokens": [201, { token: "x", expires_at: "y" }] });
    expect(await s.frame({ type: "github.token", id: "t-3", to: "github", from: "@pc", repo: "team/wiki" })).toEqual([
      { type: "reply", id: "t-3", ok: false, error: "not_installed", install: INSTALL, to: "@pc" },
    ]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/team/wiki/installation"]);
  });

  it("243 · github.app без приложения: форма для организации и для личного аккаунта; manifest закрытый, без вебхуков", async () => {
    const s = fresh();
    const calls = fakeGithub({});
    const redirect = "https://pult.example/";
    const [org] = await s.frame({ type: "github.app", id: "a-1", to: "github", from: "panel", org: "team", redirect });
    const [own] = await s.frame({ type: "github.app", id: "a-2", to: "github", from: "panel", redirect });
    type R = { app: null; form: { action: string; manifest: Record<string, unknown> } };
    const a = org.result as R;
    const b = own.result as R;
    expect(a.app).toBeNull();
    expect(a.form.action).toBe("https://github.com/organizations/team/settings/apps/new");
    expect(b.form.action).toBe("https://github.com/settings/apps/new");
    for (const m of [a.form.manifest, b.form.manifest]) {
      expect(m).toMatchObject({
        public: false,
        redirect_url: redirect,
        setup_url: redirect,
        default_permissions: { contents: "write", metadata: "read" },
        default_events: [],
      });
      expect((m.hook_attributes as { active: boolean }).active).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("244 · github.setup: код → приложение, ключ только в хранилище; повтор — app_exists; replace: true — замена", async () => {
    const s = fresh();
    let conv = { id: 1047113, slug: "switchboard-team", owner: { login: "team" }, pem: "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----\n", client_secret: "cs_SECRET", webhook_secret: "wh_SECRET" };
    const calls = fakeGithub({ "POST /app-manifests/c0de/conversions": [201, conv] });
    const log = journal();
    const first = await s.frame({ type: "github.setup", id: "s-1", v: 1, to: "github", from: "panel", code: "c0de" });
    expect(first).toEqual([
      { type: "reply", id: "s-1", ok: true, to: "panel", result: { app: { id: 1047113, slug: "switchboard-team", owner: "team" }, install: INSTALL } },
    ]);
    expect(calls[0].auth).toBeNull();
    const app1 = await stored(s);
    expect(app1).toMatchObject({ id: 1047113, slug: "switchboard-team", owner: "team", pem: conv.pem, by: "panel" });
    expect(Object.keys(app1!).sort()).toEqual(["at", "by", "id", "owner", "pem", "slug"]);
    const second = await s.frame({ type: "github.setup", id: "s-2", to: "github", from: "panel", code: "c0de" });
    expect(second).toEqual([{ type: "reply", id: "s-2", ok: false, error: "app_exists", app: { id: 1047113, slug: "switchboard-team" }, to: "panel" }]);
    expect(await stored(s)).toEqual(app1);
    expect(calls).toHaveLength(1);
    conv = { ...conv, id: 2000001, slug: "switchboard-team-2" };
    vi.mocked(fetch).mockRestore();
    fakeGithub({ "POST /app-manifests/c0de2/conversions": [201, conv] });
    const third = await s.frame({ type: "github.setup", id: "s-3", to: "github", from: "panel", code: "c0de2", replace: true });
    expect(third[0]).toMatchObject({ ok: true, result: { app: { id: 2000001, slug: "switchboard-team-2" } } });
    expect((await stored(s))?.id).toBe(2000001);
    const said = JSON.stringify([first, second, third]) + log.join("\n");
    for (const secret of ["BEGIN RSA", "cs_SECRET", "wh_SECRET"]) expect(said).not.toContain(secret);
  });

  it("245 · hello() — ровно три запроса github", async () => {
    expect(await relay.hello()).toEqual({ contract: { "github.app": 1, "github.setup": 1, "github.token": 1 } });
  });

  it("246 · секретов Worker нет, адреса нет; после перезапуска объекта токен выдан без новой настройки", async () => {
    const cfg = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, ""));
    expect([cfg.workers_dev, cfg.preview_urls, cfg.routes, cfg.route]).toEqual([false, false, undefined, undefined]);
    expect(Object.values(manifest.config)).not.toContain("secret");
    const s = home();
    await seed(s);
    await evictDurableObject(s);
    fakeGithub({
      "GET /repos/team/profiles/installation": [200, { id: 7 }],
      "POST /app/installations/7/access_tokens": [201, { token: "ghs_after", expires_at: "2026-10-31T14:00:00Z" }],
    });
    await relay.frame({ type: "github.token", id: "t-246", to: "github", from: "@laptop", repo: "team/profiles" });
    const sent = await env.RELAY_LOG.take();
    expect(sent).toEqual([
      { name: "github", frame: { type: "reply", id: "t-246", ok: true, to: "@laptop", result: { token: "ghs_after", expires_at: "2026-10-31T14:00:00Z" } } },
    ]);
  });
});

describe("github: приложение есть, отказы", () => {
  it("github.app с приложением: репозитории всех установок и ссылка установки", async () => {
    const s = fresh();
    await seed(s);
    const calls = fakeGithub({
      "GET /app/installations": [200, [{ id: 11 }, { id: 12 }]],
      "POST /app/installations/11/access_tokens": [201, { token: "t11" }],
      "POST /app/installations/12/access_tokens": [201, { token: "t12" }],
      "GET /installation/repositories": [200, { repositories: [{ full_name: "team/profiles" }] }],
    });
    const [r] = await s.frame({ type: "github.app", id: "a-3", to: "github", from: "panel", redirect: "https://pult.example/" });
    expect(r.result).toEqual({ app: { id: 1047113, slug: "switchboard-team", owner: "team" }, repos: ["team/profiles", "team/profiles"], install: INSTALL });
    expect(calls.filter((c) => c.path.startsWith("/installation/")).map((c) => c.auth)).toEqual(["token t11", "token t12"]);
  });

  it("github.app: репозиториев больше страницы — все страницы", async () => {
    const s = fresh();
    await seed(s);
    const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `team/r${String(i).padStart(3, "0")}` }));
    const calls = fakeGithub({
      "GET /app/installations": [200, [{ id: 11 }]],
      "POST /app/installations/11/access_tokens": [201, { token: "t11" }],
      "GET /installation/repositories?per_page=100&page=1": [200, { repositories: page1 }],
      "GET /installation/repositories?per_page=100&page=2": [200, { repositories: [{ full_name: "team/switchboard" }] }],
    });
    const [r] = await s.frame({ type: "github.app", id: "a-4", to: "github", from: "panel", redirect: "https://pult.example/" });
    expect((r.result as { repos: string[] }).repos).toHaveLength(101);
    expect((r.result as { repos: string[] }).repos).toContain("team/switchboard");
    expect(calls.filter((c) => c.path.startsWith("/installation/")).map((c) => c.path)).toEqual([
      "/installation/repositories?per_page=100&page=1",
      "/installation/repositories?per_page=100&page=2",
    ]);
  });

  it("GitHub ответил 500 — github_failed; статус и текст в журнале, токена в журнале нет", async () => {
    const s = fresh();
    await seed(s);
    fakeGithub({ "GET /repos/team/profiles/installation": [500, { message: "boom" }] });
    const log = journal();
    expect(await s.frame({ type: "github.token", id: "t-5", to: "github", from: "@laptop", repo: "team/profiles" })).toMatchObject([
      { ok: false, error: "github_failed" },
    ]);
    expect(log.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ word: "github_failed", status: 500, text: '{"message":"boom"}' }));
  });

  it("сети нет — github_failed с причиной", async () => {
    const s = fresh();
    await seed(s);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network connection lost"));
    expect(await s.frame({ type: "github.token", id: "t-6", to: "github", from: "@laptop", repo: "team/profiles" })).toMatchObject([
      { ok: false, error: "github_failed" },
    ]);
  });

  it("repo не вида владелец/имя, нет code или redirect — bad_frame; чужое имя — unknown_request", async () => {
    const s = fresh();
    const calls = fakeGithub({});
    const bad = async (f: Frame) => (await s.frame({ to: "github", from: "panel", id: "b", ...f }))[0];
    expect(await bad({ type: "github.token", repo: "../etc" })).toMatchObject({ error: "bad_frame" });
    expect(await bad({ type: "github.token", repo: "team/x/y" })).toMatchObject({ error: "bad_frame" });
    expect(await bad({ type: "github.setup" })).toMatchObject({ error: "bad_frame" });
    expect(await bad({ type: "github.app" })).toMatchObject({ error: "bad_frame" });
    expect(await bad({ type: "github.secrets" })).toMatchObject({ error: "unknown_request" });
    expect(calls).toHaveLength(0);
  });
});
