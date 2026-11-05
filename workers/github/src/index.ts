// Worker github: POST кадра с пропуском → запросы к API GitHub → ответ или слово отказа. Ключ приложения — только в таблице app.
import { createSign } from "node:crypto";
import { entrance, type GateApi } from "@switchboard/gate";
import { accepts, BAD_FRAME, CALL_MS, fail, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT, type AppInfo } from "../contract.ts";

type Env = { DB: D1Database; GATE: GateApi };
type App = AppInfo & { pem: string };

const API = "https://api.github.com";
const PAGE = 100;
const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/;
const ORG = /^[A-Za-z0-9-]+$/;
const CODE = /^[\w-]+$/;
const URL_HTTP = /^https?:\/\//;

/** Поле кадра — строка этого вида. Без typeof RegExp.test приведёт undefined к строке "undefined": под CODE она подходит. */
const fits = (form: RegExp, x: unknown): x is string => typeof x === "string" && form.test(x);

const log = (kind: "note" | "refuse", ev: unknown, fields: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "github", kind, ev, ...fields }));

/** Отказ словом: reply — поля ответа рядом со словом, journal — только в журнал. */
class Refusal extends Error {
  readonly word: string;
  readonly why: string;
  readonly reply: Record<string, unknown>;
  readonly journal: Record<string, unknown>;

  constructor(word: string, why: string, reply: Record<string, unknown> = {}, journal: Record<string, unknown> = {}) {
    super(`${word}: ${why}`);
    this.word = word;
    this.why = why;
    this.reply = reply;
    this.journal = journal;
  }
}

/** Запрос к API. Статус вне 2xx — ответ как есть для вызывающего: 404 у установки значит «не допущено». */
async function call(path: string, auth?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": "switchboard-github", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (auth) headers.authorization = auth;
  if (body) headers["content-type"] = "application/json";
  try {
    return await fetch(API + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(CALL_MS) });
  } catch (e) {
    throw new Refusal("github_failed", `GitHub недоступен: ${String(e)}`, {}, { status: 0 });
  }
}

async function json<T>(r: Response): Promise<T> {
  if (r.ok) return r.json<T>();
  throw new Refusal("github_failed", `GitHub ответил ${r.status}`, {}, { status: r.status, text: await r.text() });
}

/** Все страницы списка: страница короче полной — последняя. */
async function pages<P, T>(path: string, auth: string, items: (page: P) => T[]): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const got = items(await json<P>(await call(`${path}?per_page=${PAGE}&page=${page}`, auth)));
    all.push(...got);
    if (got.length < PAGE) return all;
  }
}

/** JWT приложения: начало на минуту назад, срок 9 минут вперёд; предел GitHub — 10 минут. */
function jwt(app: App): string {
  const b64u = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000) - 60;
  const signed = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({ iat, exp: iat + 600, iss: String(app.id) })}`;
  return `Bearer ${signed}.${createSign("RSA-SHA256").update(signed).sign(app.pem, "base64url")}`;
}

const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;
const stored = (db: D1Database) => db.prepare("SELECT id, slug, owner, pem FROM app WHERE one = 1").first<App>();

const issue = async (installation: number, auth: string, body: unknown) => json<{ token: string; expires_at: string }>(await call(`/app/installations/${installation}/access_tokens`, auth, body));

async function appRequest(db: D1Database, f: Frame) {
  const { redirect, org } = f as Frame & { redirect: string; org?: string };
  if (!fits(URL_HTTP, redirect)) throw new Refusal(BAD_FRAME, "нет redirect — адреса пульта");
  if (org !== undefined && !fits(ORG, org)) throw new Refusal(BAD_FRAME, "org — не имя организации");
  const app = await stored(db);
  if (!app) {
    const manifest = {
      name: org ? `Switchboard ${org}` : "Switchboard",
      url: redirect,
      public: false,
      redirect_url: redirect,
      setup_url: redirect,
      hook_attributes: { url: redirect, active: false },
      default_permissions: { contents: "write", metadata: "read" },
      default_events: [],
    };
    return { app: null, form: { action: org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new", manifest } };
  }
  const auth = jwt(app);
  const repos: string[] = [];
  for (const { id } of await pages("/app/installations", auth, (p: { id: number }[]) => p)) {
    const { token } = await issue(id, auth, { permissions: { metadata: "read" } });
    repos.push(...(await pages("/installation/repositories", `token ${token}`, (p: { repositories: { full_name: string }[] }) => p.repositories.map((r) => r.full_name))));
  }
  return { app: { id: app.id, slug: app.slug, owner: app.owner }, repos: repos.sort(), install: installUrl(app.slug) };
}

async function setup(db: D1Database, f: Frame) {
  const { code, replace, from } = f as Frame & { code: string; replace?: boolean };
  if (!fits(CODE, code)) throw new Refusal(BAD_FRAME, "нет code из возврата GitHub");
  const had = await stored(db);
  if (had && !replace) throw new Refusal("app_exists", "приложение уже есть; заменить — replace: true", { app: { id: had.id, slug: had.slug } });
  const { id, slug, owner, pem } = await json<AppInfo & { owner: { login: string }; pem: string }>(await call(`/app-manifests/${code}/conversions`, undefined, {}));
  await db.prepare("INSERT OR REPLACE INTO app (one, id, slug, owner, pem, at, by) VALUES (1, ?, ?, ?, ?, ?, ?)").bind(id, slug, owner.login, pem, Date.now(), from).run();
  log("note", f.type, { from, app: id, slug, owner: owner.login, replaced: !!had });
  return { app: { id, slug, owner: owner.login }, install: installUrl(slug) };
}

async function token(db: D1Database, f: Frame) {
  const { repo, from } = f as Frame & { repo: string };
  if (!fits(REPO, repo)) throw new Refusal(BAD_FRAME, "repo — не вида владелец/имя");
  const app = await stored(db);
  if (!app) throw new Refusal("no_app", "приложения ещё нет: github.setup не делали");
  const auth = jwt(app);
  const found = await call(`/repos/${repo}/installation`, auth);
  if (found.status === 404) throw new Refusal("not_installed", `приложение не допущено к ${repo}`, { install: installUrl(app.slug) }, { repo });
  const { id } = await json<{ id: number }>(found);
  const { token: value, expires_at } = await issue(id, auth, { repositories: [repo.split("/")[1]], permissions: { contents: "write" } });
  log("note", f.type, { from, repo, installation: id });
  return { token: value, expires_at };
}

const HANDLERS: Record<string, (db: D1Database, f: Frame) => Promise<unknown>> = { "github.app": appRequest, "github.setup": setup, "github.token": token };

async function serve(db: D1Database, f: Frame): Promise<Frame[]> {
  const to = f.from ?? "";
  try {
    const bad = accepts(f, CONTRACT);
    if (bad) throw new Refusal(bad.word, bad.why);
    if (!f.id) throw new Refusal(BAD_FRAME, `${f.type} без id — ответить некому`);
    return [{ ...ok(f.id, await HANDLERS[f.type](db, f)), to }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    log("refuse", f.type, { word: e.word, why: e.why, from: to, ...e.journal });
    return f.id ? [{ ...fail(f.id, e.word), ...e.reply, to }] : [];
  }
}

export default {
  fetch: (req: Request, env: Env) => entrance(req, env.GATE, (f) => serve(env.DB, f)),
} satisfies ExportedHandler<Env>;
