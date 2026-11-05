// Леса границы «токен приложения GitHub для сессий». Снаружи: API GitHub (подделка fetch), gate (стенд), D1 стенда.
// Вход — POST кадра с пропуском, других дверей у Worker'а нет; исход — ответ, запрос к GitHub, строка таблицы app, строка журнала.
// Номер — эталон-источник; свойства без пометки — чьё: код. Формат таблицы app держат запись и чтение SQL в самих тестах.
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import wrangler from "../wrangler.jsonc?raw";
import manifest from "../module.json" with { type: "json" };

const worker = (exports as unknown as { default: unknown }).default as { fetch(r: Request): Promise<Response> };
const DB = (env as unknown as { DB: D1Database }).DB;
beforeAll(() => applyD1Migrations(DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS));
beforeEach(() => DB.exec("DELETE FROM app"));
afterEach(() => vi.restoreAllMocks());

type Stored = { id: number; slug: string; owner: string; pem: string; at: number; by: string };
type Call = { method: string; path: string; auth: string | null; body: unknown; signal: AbortSignal; headers: Headers };
type Route = [number, unknown] | ((c: Call) => [number, unknown]);

const INSTALL = "https://github.com/apps/switchboard-team/installations/new";
const REDIRECT = "https://pult.example/";
const pems = { pkcs1: "", pkcs8: "" };
let pub: CryptoKey;

const armored = (label: string, der: Uint8Array) => {
  let s = "";
  for (const b of der) s += String.fromCharCode(b);
  return `-----BEGIN ${label}-----\n${btoa(s).replace(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;
};

/** Ключ приложения теста: PKCS#1 — как его отдаёт GitHub, PKCS#8 — как его ест WebCrypto. */
beforeAll(async () => {
  const k = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  pub = k.publicKey;
  const p8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", k.privateKey)) as ArrayBuffer);
  // PrivateKeyInfo 2048 бит: 30 82 xx xx | 02 01 00 | 30 0d …(15) | 04 82 xx xx | PKCS#1
  expect([p8[0], p8[4], p8[7], p8[22]]).toEqual([0x30, 0x02, 0x30, 0x04]);
  pems.pkcs8 = armored("PRIVATE KEY", p8);
  pems.pkcs1 = armored("RSA PRIVATE KEY", p8.slice(26));
});

const APP = (pem = pems.pkcs1): Stored => ({ id: 1047113, slug: "switchboard-team", owner: "team", pem, at: 1793457720000, by: "panel" });
const seed = (a: Stored = APP()) => DB.prepare("INSERT OR REPLACE INTO app (one, id, slug, owner, pem, at, by) VALUES (1, ?, ?, ?, ?, ?, ?)").bind(a.id, a.slug, a.owner, a.pem, a.at, a.by).run();
const stored = async () => (await DB.prepare("SELECT id, slug, owner, pem, at, by FROM app WHERE one = 1").first<Stored>()) ?? undefined;
/** Адрес клиента со стенда gate. Машина — @имя, пропуск стенда говорит адрес сам. */
const PANEL = "panel~test@example.com";
const passOf = (from: string) => (from.startsWith("@") ? `host.${from.slice(1)}.1.s3cr3t` : `client.${from.split("~")[0]}.2.s3cr3t`);
/** Кадр через вход Worker'а: ответ телом, на кадр без id — без тела. */
async function ask({ from = "@laptop", ...f }: Record<string, unknown>): Promise<Frame[]> {
  const r = await worker.fetch(new Request("https://github.test/", { method: "POST", body: JSON.stringify({ v: 1, to: ".github", key: passOf(from as string), ...f }) }));
  return r.status === 204 ? [] : [(await r.json()) as Frame];
}

/** Поддельный GitHub: маршрут «МЕТОД путь» или «МЕТОД путь?запрос» → [статус, тело]. Чужой маршрут — 404. */
function fakeGithub(routes: Record<string, Route> = {}) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    const call: Call = { method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined, signal: req.signal, headers: req.headers };
    calls.push(call);
    expect(url.origin).toBe("https://api.github.com");
    const r = routes[`${call.method} ${call.path}`] ?? routes[`${call.method} ${url.pathname}`];
    if (!r) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const [status, body] = typeof r === "function" ? r(call) : r;
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

function journal() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(String(s)));
  return { text: () => lines.join("\n"), rows: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const fromB64u = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function verifyJwt(auth: string | null) {
  const [head, body, sig] = (auth ?? "").replace(/^Bearer /, "").split(".");
  const raw = Uint8Array.from(fromB64u(sig), (c) => c.charCodeAt(0));
  const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, raw, new TextEncoder().encode(`${head}.${body}`));
  return { good, head: JSON.parse(fromB64u(head)), claims: JSON.parse(fromB64u(body)) as { iat: number; exp: number; iss: string } };
}

const routeList = (calls: Call[]) => calls.map((c) => `${c.method} ${c.path}`);
const TOKEN_ROUTES = {
  "GET /repos/team/profiles/installation": [200, { id: 58203311, account: { login: "team" } }],
  "POST /app/installations/58203311/access_tokens": [201, { token: "ghs_test", expires_at: "2026-10-31T13:02:11Z" }],
} satisfies Record<string, Route>;

describe("github.token", () => {
  it.each([
    ["ключ PKCS#1 — как отдаёт GitHub", "pkcs1"],
    ["ключ PKCS#8", "pkcs8"],
  ] as const)("240 · JWT приложения → установка → токен только на этот репозиторий и содержимое; строка таблицы не меняется, токена нет в журнале: %s", async (_n, form) => {
    await seed(APP(pems[form]));
    const calls = fakeGithub(TOKEN_ROUTES);
    const log = journal();
    const before = Date.now();
    const out = await ask({ type: "github.token", id: "t-9", repo: "team/profiles" });
    expect(out).toEqual([{ type: "reply", id: "t-9", ok: true, to: "@laptop", result: { token: "ghs_test", expires_at: "2026-10-31T13:02:11Z" } }]);
    expect(routeList(calls)).toEqual(["GET /repos/team/profiles/installation", "POST /app/installations/58203311/access_tokens"]);
    expect(calls[1].body).toEqual({ repositories: ["profiles"], permissions: { contents: "write" } });
    expect(calls[1].auth).toBe(calls[0].auth);
    const jwt = await verifyJwt(calls[0].auth);
    expect(jwt.good).toBe(true);
    expect(jwt.head).toEqual({ alg: "RS256", typ: "JWT" });
    expect(jwt.claims.iss).toBe("1047113");
    // срок 9 минут вперёд, начало на минуту назад; предел GitHub — 10 минут
    expect(jwt.claims.exp - jwt.claims.iat).toBe(600);
    expect(Math.abs(jwt.claims.iat - (Math.floor(before / 1000) - 60))).toBeLessThanOrEqual(5);
    for (const c of calls) {
      expect(c.headers.get("user-agent")).toBe("switchboard-github");
      expect(c.headers.get("accept")).toBe("application/vnd.github+json");
      expect(c.headers.get("x-github-api-version")).toBe("2022-11-28");
    }
    expect(calls[1].headers.get("content-type")).toBe("application/json");
    expect(await stored()).toEqual(APP(pems[form]));
    expect(log.text()).not.toContain("ghs_test");
    expect(log.text()).not.toContain("PRIVATE KEY");
    expect(log.rows()).toContainEqual(expect.objectContaining({ part: "github", kind: "note", ev: "github.token", from: "@laptop", repo: "team/profiles", installation: 58203311 }));
  });

  it("241 · таблица пуста: no_app, GitHub не вызван, строка журнала со словом и отправителем", async () => {
    const calls = fakeGithub();
    const log = journal();
    expect(await ask({ type: "github.token", id: "t-1", repo: "team/profiles" })).toEqual([{ type: "reply", id: "t-1", ok: false, error: "no_app", to: "@laptop" }]);
    expect(calls).toHaveLength(0);
    expect(log.rows()).toContainEqual(expect.objectContaining({ part: "github", kind: "refuse", ev: "github.token", word: "no_app", from: "@laptop", why: "приложения ещё нет: github.setup не делали" }));
  });

  it("242 · установки у репозитория нет (404): not_installed со ссылкой установки, токен не запрашивался", async () => {
    await seed();
    const calls = fakeGithub();
    const log = journal();
    expect(await ask({ type: "github.token", id: "t-3", from: "@pc", repo: "team/wiki" })).toEqual([{ type: "reply", id: "t-3", ok: false, error: "not_installed", install: INSTALL, to: "@pc" }]);
    expect(routeList(calls)).toEqual(["GET /repos/team/wiki/installation"]);
    expect(log.rows()).toContainEqual(expect.objectContaining({ word: "not_installed", repo: "team/wiki", why: "приложение не допущено к team/wiki" }));
  });

  it.each([
    ["500 на установку", { "GET /repos/team/profiles/installation": [500, { message: "boom" }] }, 500, '{"message":"boom"}', "GitHub ответил 500"],
    ["422 на токен", { "GET /repos/team/profiles/installation": [200, { id: 7 }], "POST /app/installations/7/access_tokens": [422, { message: "no" }] }, 422, '{"message":"no"}', "GitHub ответил 422"],
  ] as Array<[string, Record<string, Route>, number, string, string]>)("2029 · GitHub ответил не тем: github_failed; статус и текст только в журнале: %s", async (_n, routes, status, text, why) => {
    await seed();
    fakeGithub(routes);
    const log = journal();
    const out = await ask({ type: "github.token", id: "t-5", repo: "team/profiles" });
    expect(out).toEqual([{ type: "reply", id: "t-5", ok: false, error: "github_failed", to: "@laptop" }]);
    expect(log.rows()).toContainEqual(expect.objectContaining({ kind: "refuse", ev: "github.token", word: "github_failed", status, text, why }));
  });

  it.each([
    ["сети нет", () => new TypeError("Network connection lost"), "Network connection lost"],
    ["сработал предел запроса", () => new DOMException("The operation was aborted due to timeout", "TimeoutError"), "aborted due to timeout"],
  ] as const)("5186 · ответа нет: github_failed со статусом 0; запрос идёт с сигналом отмены (слово пользователя 2 нояб.): %s", async (_n, err, part) => {
    await seed();
    const signals: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      throw err();
    });
    const log = journal();
    expect(await ask({ type: "github.token", id: "t-6", repo: "team/profiles" })).toEqual([{ type: "reply", id: "t-6", ok: false, error: "github_failed", to: "@laptop" }]);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    const row = log.rows().find((r) => r.word === "github_failed")!;
    expect(row.status).toBe(0);
    expect(String(row.why)).toMatch(/^GitHub недоступен: /);
    expect(String(row.why)).toContain(part);
  });

  it.each(["../etc", "team/x/y", "x", "a/..", "a/.", undefined])("2023 · repo не вида владелец/имя — bad_frame, GitHub не вызван: %s", async (repo) => {
    await seed();
    const calls = fakeGithub();
    const log = journal();
    expect(await ask({ type: "github.token", id: "b", repo })).toEqual([{ type: "reply", id: "b", ok: false, error: "bad_frame", to: "@laptop" }]);
    expect(calls).toHaveLength(0);
    expect(log.rows()).toContainEqual(expect.objectContaining({ word: "bad_frame", why: "repo — не вида владелец/имя" }));
  });
});

describe("github.app", () => {
  it.each([
    ["организация", "team", "https://github.com/organizations/team/settings/apps/new", "Switchboard team"],
    ["личный аккаунт", undefined, "https://github.com/settings/apps/new", "Switchboard"],
  ])("243 · приложения нет: форма manifest, закрытое приложение с записью содержимого, без вебхуков; GitHub не вызван: %s", async (_n, org, action, name) => {
    const calls = fakeGithub();
    const [r] = await ask({ type: "github.app", id: "a-1", from: PANEL, redirect: REDIRECT, org });
    expect(r).toMatchObject({ type: "reply", id: "a-1", ok: true, to: PANEL });
    expect(r.result).toEqual({
      app: null,
      form: {
        action,
        manifest: {
          name,
          url: REDIRECT,
          public: false,
          redirect_url: REDIRECT,
          setup_url: REDIRECT,
          hook_attributes: { url: REDIRECT, active: false },
          default_permissions: { contents: "write", metadata: "read" },
          default_events: [],
        },
      },
    });
    expect(calls).toHaveLength(0);
  });

  it("2026 · приложение есть: репозитории всех установок по алфавиту и ссылка установки; токены установок — только metadata: read; ключа нет ни в ответе, ни в журнале", async () => {
    await seed();
    const own: Record<string, string[]> = { "token t11": ["team/zeta", "team/mid"], "token t12": ["team/alpha"] };
    const calls = fakeGithub({
      "GET /app/installations": [200, [{ id: 11 }, { id: 12 }]],
      "POST /app/installations/11/access_tokens": [201, { token: "t11" }],
      "POST /app/installations/12/access_tokens": [201, { token: "t12" }],
      "GET /installation/repositories": (c) => [200, { repositories: own[c.auth ?? ""].map((full_name) => ({ full_name })) }],
    });
    const log = journal();
    const [r] = await ask({ type: "github.app", id: "a-3", from: PANEL, redirect: REDIRECT });
    expect(r.result).toEqual({ app: { id: 1047113, slug: "switchboard-team", owner: "team" }, repos: ["team/alpha", "team/mid", "team/zeta"], install: INSTALL });
    expect(calls.filter((c) => c.path.startsWith("/installation/")).map((c) => c.auth)).toEqual(["token t11", "token t12"]);
    expect(calls.filter((c) => c.path.endsWith("/access_tokens")).map((c) => c.body)).toEqual([{ permissions: { metadata: "read" } }, { permissions: { metadata: "read" } }]);
    expect((await verifyJwt(calls[0].auth)).good).toBe(true);
    expect(JSON.stringify(r) + log.text()).not.toContain("PRIVATE KEY");
  });

  it("приложение есть, установок ещё нет: пустой список и ссылка установки", async () => {
    await seed();
    fakeGithub({ "GET /app/installations": [200, []] });
    const [r] = await ask({ type: "github.app", id: "a-2", from: PANEL, redirect: REDIRECT });
    expect(r.result).toEqual({ app: { id: 1047113, slug: "switchboard-team", owner: "team" }, repos: [], install: INSTALL });
  });

  it("списки длиннее страницы: установки и репозитории — все страницы по 100, пока страница не короче", async () => {
    await seed();
    const inst = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const repos = Array.from({ length: 100 }, (_, i) => ({ full_name: `team/r${String(i).padStart(3, "0")}` }));
    const routes: Record<string, Route> = {
      "GET /app/installations?per_page=100&page=1": [200, inst],
      "GET /app/installations?per_page=100&page=2": [200, []],
      "GET /installation/repositories?per_page=100&page=1": (c) => [200, { repositories: c.auth === "token t1" ? repos : [] }],
      "GET /installation/repositories?per_page=100&page=2": [200, { repositories: [{ full_name: "team/switchboard" }] }],
    };
    for (const { id } of inst) routes[`POST /app/installations/${id}/access_tokens`] = [201, { token: `t${id}` }];
    const calls = fakeGithub(routes);
    const [r] = await ask({ type: "github.app", id: "a-4", from: PANEL, redirect: REDIRECT });
    const got = (r.result as { repos: string[] }).repos;
    expect(got).toHaveLength(101);
    expect(got).toContain("team/switchboard");
    expect(calls.filter((c) => c.path.startsWith("/app/installations?")).map((c) => c.path)).toEqual(["/app/installations?per_page=100&page=1", "/app/installations?per_page=100&page=2"]);
  });

  it.each([
    ["список установок 500", { "GET /app/installations": [500, { message: "boom" }] }, 500],
    ["токен установки 403", { "GET /app/installations": [200, [{ id: 11 }]], "POST /app/installations/11/access_tokens": [403, { message: "no" }] }, 403],
    ["репозитории 502", { "GET /app/installations": [200, [{ id: 11 }]], "POST /app/installations/11/access_tokens": [201, { token: "t" }], "GET /installation/repositories": [502, { message: "bad" }] }, 502],
  ] as Array<[string, Record<string, Route>, number]>)("2027 · GitHub ответил не тем: github_failed со статусом в журнале: %s", async (_n, routes, status) => {
    await seed();
    fakeGithub(routes);
    const log = journal();
    expect(await ask({ type: "github.app", id: "a-5", from: PANEL, redirect: REDIRECT })).toEqual([{ type: "reply", id: "a-5", ok: false, error: "github_failed", to: PANEL }]);
    expect(log.rows()).toContainEqual(expect.objectContaining({ ev: "github.app", word: "github_failed", status }));
  });

  it.each([
    ["нет redirect", {}, "нет redirect — адреса пульта"],
    ["redirect не http", { redirect: "ftp://x" }, "нет redirect — адреса пульта"],
    ["org с пробелом", { redirect: REDIRECT, org: "a b" }, "org — не имя организации"],
    ["org не строка", { redirect: REDIRECT, org: 5 }, "org — не имя организации"],
  ])("2021 · bad_frame, GitHub не вызван: %s", async (_n, f, why) => {
    const calls = fakeGithub();
    const log = journal();
    expect(await ask({ type: "github.app", id: "b", from: PANEL, ...f })).toEqual([{ type: "reply", id: "b", ok: false, error: "bad_frame", to: PANEL }]);
    expect(calls).toHaveLength(0);
    expect(log.rows()).toContainEqual(expect.objectContaining({ word: "bad_frame", why }));
  });
});

describe("github.setup", () => {
  const CONV = { id: 1047113, slug: "switchboard-team", owner: { login: "team" }, pem: "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----\n", client_secret: "cs_SECRET", webhook_secret: "wh_SECRET" };

  it("244 · код меняется на приложение, ключ только в таблице; повтор — app_exists, таблица та же; replace: true — замена; секретов нет в ответах и журнале", async () => {
    const calls = fakeGithub({
      "POST /app-manifests/c0de/conversions": [201, CONV],
      "POST /app-manifests/c0de2/conversions": [201, { ...CONV, id: 2000001, slug: "switchboard-team-2" }],
    });
    const log = journal();
    const before = Date.now();
    const first = await ask({ type: "github.setup", id: "s-1", from: PANEL, code: "c0de" });
    expect(first).toEqual([{ type: "reply", id: "s-1", ok: true, to: PANEL, result: { app: { id: 1047113, slug: "switchboard-team", owner: "team" }, install: INSTALL } }]);
    expect(calls[0].auth).toBeNull();
    const row = await stored();
    expect(row).toMatchObject({ id: 1047113, slug: "switchboard-team", owner: "team", pem: CONV.pem, by: PANEL });
    expect(row!.at).toBeGreaterThanOrEqual(before);
    const second = await ask({ type: "github.setup", id: "s-2", from: PANEL, code: "c0de" });
    expect(second).toEqual([{ type: "reply", id: "s-2", ok: false, error: "app_exists", app: { id: 1047113, slug: "switchboard-team" }, to: PANEL }]);
    expect(await stored()).toEqual(row);
    expect(calls).toHaveLength(1);
    const third = await ask({ type: "github.setup", id: "s-3", from: PANEL, code: "c0de2", replace: true });
    expect(third[0]).toMatchObject({ ok: true, result: { app: { id: 2000001, slug: "switchboard-team-2" }, install: "https://github.com/apps/switchboard-team-2/installations/new" } });
    expect((await stored())?.id).toBe(2000001);
    const said = JSON.stringify([first, second, third]) + log.text() + JSON.stringify(await stored());
    for (const secret of ["cs_SECRET", "wh_SECRET"]) expect(said).not.toContain(secret);
    expect(JSON.stringify([first, second, third]) + log.text()).not.toContain("BEGIN RSA");
    expect(log.rows().filter((l) => l.ev === "github.setup" && l.kind === "note").map((l) => [l.from, l.app, l.slug, l.owner, l.replaced])).toEqual([
      [PANEL, 1047113, "switchboard-team", "team", false],
      [PANEL, 2000001, "switchboard-team-2", "team", true],
    ]);
    expect(log.rows()).toContainEqual(expect.objectContaining({ word: "app_exists", why: "приложение уже есть; заменить — replace: true" }));
  });

  it("у приложения GitHub не назвал владельца: пустая строка", async () => {
    const { owner: _owner, ...noOwner } = CONV;
    fakeGithub({ "POST /app-manifests/c0de/conversions": [201, noOwner] });
    const [r] = await ask({ type: "github.setup", id: "s-4", from: PANEL, code: "c0de" });
    expect(r.result).toMatchObject({ app: { owner: "" } });
    expect((await stored())?.owner).toBe("");
  });

  it("2028 · GitHub не обменял code: github_failed, прежнее приложение цело", async () => {
    await seed();
    const calls = fakeGithub();
    const log = journal();
    expect(await ask({ type: "github.setup", id: "s-9", from: PANEL, code: "bad0", replace: true })).toEqual([{ type: "reply", id: "s-9", ok: false, error: "github_failed", to: PANEL }]);
    expect(routeList(calls)).toEqual(["POST /app-manifests/bad0/conversions"]);
    expect(await stored()).toEqual(APP());
    expect(log.rows()).toContainEqual(expect.objectContaining({ ev: "github.setup", word: "github_failed", status: 404 }));
  });

  it.each([undefined, "../x", "a b"])("2022 · code не из [A-Za-z0-9_-] — bad_frame, GitHub не вызван: %s", async (code) => {
    const calls = fakeGithub();
    const log = journal();
    expect(await ask({ type: "github.setup", id: "b", from: PANEL, code })).toEqual([{ type: "reply", id: "b", ok: false, error: "bad_frame", to: PANEL }]);
    expect(calls).toHaveLength(0);
    expect(log.rows()).toContainEqual(expect.objectContaining({ word: "bad_frame", why: "нет code из возврата GitHub" }));
  });
});

describe("вход Worker'а", () => {
  it.each([
    ["чужое имя", { type: "github.secrets", id: "b" }, [{ error: "unknown_request", ok: false, to: PANEL }], ["refuse", "unknown_request", "github.secrets не обслуживается"]],
    ["другая версия", { type: "github.app", id: "b", v: 2, redirect: REDIRECT }, [{ error: "contract_mismatch", ok: false, to: PANEL }], ["refuse", "contract_mismatch", "github.app — запрошена v2, здесь v1"]],
    ["без id", { type: "github.app", redirect: REDIRECT }, [], ["refuse", "bad_frame", "github.app без id — ответить некому"]],
  ])("2020 · вход отклонён, GitHub не вызван: %s", async (_n, f, out, [kind, word, why]) => {
    const calls = fakeGithub();
    const log = journal();
    const got = await ask({ from: PANEL, ...f });
    expect(got).toHaveLength(out.length);
    if (out.length) expect(got[0]).toMatchObject(out[0]);
    expect(calls).toHaveLength(0);
    expect(log.rows()).toEqual([expect.objectContaining({ part: "github", kind, why, from: PANEL, ...(word ? { word } : {}) })]);
  });

  it("246 · прямой вход: POST с пропуском — отправитель из пропуска, from из тела не берётся; строка таблицы приложения хватает для токена без новой настройки", async () => {
    await seed();
    fakeGithub({
      "GET /repos/team/profiles/installation": [200, { id: 7 }],
      "POST /app/installations/7/access_tokens": [201, { token: "ghs_after", expires_at: "2026-10-31T14:00:00Z" }],
    });
    const log = journal();
    const r = await worker.fetch(new Request("https://github.test/", { method: "POST", body: JSON.stringify({ type: "github.token", v: 1, id: "t-246", from: "чужой", key: "host.laptop.1.s3cr3t", repo: "team/profiles" }) }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ type: "reply", id: "t-246", ok: true, to: "@laptop", result: { token: "ghs_after", expires_at: "2026-10-31T14:00:00Z" } });
    expect(log.rows()).toContainEqual(expect.objectContaining({ ev: "github.token", from: "@laptop" }));
    expect(log.text()).not.toContain("чужой");
  });

  it("прямой вход: плохой пропуск — bad_key, GitHub и таблица не тронуты", async () => {
    await seed();
    const calls = fakeGithub();
    const r = await worker.fetch(new Request("https://github.test/", { method: "POST", body: JSON.stringify({ type: "github.setup", v: 1, id: "t-b", key: "host.laptop.1.bad", code: "c0de", replace: true }) }));
    expect(await r.json()).toMatchObject({ ok: false, error: "bad_key", id: "t-b" });
    expect(calls).toHaveLength(0);
    expect(await stored()).toEqual(APP());
  });

  it("246 · секретов Worker нет: ключ только в его базе; адрес — workers.dev без предпросмотров; база и gate по привязкам", () => {
    const cfg = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, ""));
    expect([cfg.workers_dev, cfg.preview_urls, cfg.routes, cfg.route]).toEqual([true, false, undefined, undefined]);
    expect(manifest.config).toEqual({ GATE: "binding", DB: "binding" });
    expect(cfg.env.prod.routes).toEqual([{ pattern: "github.pfarm.app", custom_domain: true }]);
  });
});
