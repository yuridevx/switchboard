// Worker github: POST кадра с пропуском → запросы к API GitHub → ответ или слово отказа.
// Приложение флота — одна строка таблицы app, ключ только в ней; токенов модуль не хранит.
import { createSign } from "node:crypto";
import { entrance, type GateApi } from "@switchboard/gate";
import { accepts, BAD_FRAME, CALL_MS, fail, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT, type AppInfo } from "../contract.ts";

type Env = { DB: D1Database; GATE: GateApi };
type App = AppInfo & { pem: string };
type Answer = { ok: boolean; status: number; text: string };

const PAGE = 100;
const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/;
const ORG = /^[A-Za-z0-9-]+$/;
const CODE = /^[\w-]+$/;
const HTTP = /^https?:\/\//;

/** Поле кадра — строка этого вида. Без typeof RegExp.test приведёт undefined к строке "undefined": под CODE она подходит. */
const fits = (form: RegExp, x: unknown): x is string => typeof x === "string" && form.test(x);

/** Журнал — Workers Logs, строка JSON в общем формате журналов. Токенов и ключей здесь нет. */
const log = (kind: "note" | "refuse", ev: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "github", kind, ev, ...fields }));

/** Отказ словом контракта: message — причина для журнала, reply — поля в ответ, row — только в журнал. */
class Refusal extends Error {
  readonly word: string;
  readonly reply: Record<string, unknown>;
  readonly row: Record<string, unknown>;

  constructor(word: string, why: string, reply: Record<string, unknown> = {}, row: Record<string, unknown> = {}) {
    super(why);
    this.word = word;
    this.reply = reply;
    this.row = row;
  }
}

/** Запрос к API с пределом. Тело читается здесь же: обрыв на нём — тот же отказ, что обрыв на запросе. */
async function call(method: "GET" | "POST", path: string, auth?: string, body?: object): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": "switchboard-github", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (auth) headers.authorization = auth;
  if (body) headers["content-type"] = "application/json";
  try {
    const r = await fetch(`https://api.github.com${path}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    throw new Refusal("github_failed", `GitHub недоступен: ${e}`, {}, { status: 0 });
  }
}

function json<T>({ ok: good, status, text }: Answer): T {
  if (!good) throw new Refusal("github_failed", `GitHub ответил ${status}`, {}, { status, text });
  return JSON.parse(text) as T;
}

/** Все страницы по 100, пока страница не короче. */
async function pages<P, T>(path: string, auth: string, items: (page: P) => T[]): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const got = items(json<P>(await call("GET", `${path}?per_page=${PAGE}&page=${page}`, auth)));
    all.push(...got);
    if (got.length < PAGE) return all;
  }
}

/** JWT приложения: начало на минуту назад — часы GitHub могут отставать; срок 9 минут вперёд, предел GitHub — 10. */
function jwt({ id, pem }: App): string {
  const b64u = (x: object) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000) - 60;
  const signed = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({ iat, exp: iat + 600, iss: String(id) })}`;
  return `Bearer ${signed}.${createSign("RSA-SHA256").update(signed).sign(pem, "base64url")}`;
}

const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;
const readApp = (db: D1Database) => db.prepare("SELECT id, slug, owner, pem FROM app WHERE one = 1").first<App>();
const issue = async (installation: number, auth: string, body: object) => json<{ token: string; expires_at: string }>(await call("POST", `/app/installations/${installation}/access_tokens`, auth, body));

/** Форма для браузера: закрытое приложение с записью содержимого, без вебхуков. */
const manifestForm = (redirect: string, org?: string) => ({
  action: org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new",
  manifest: {
    name: org ? `Switchboard ${org}` : "Switchboard",
    url: redirect,
    public: false,
    redirect_url: redirect,
    setup_url: redirect,
    hook_attributes: { url: redirect, active: false },
    default_permissions: { contents: "write", metadata: "read" },
    default_events: [],
  },
});

async function appInfo(db: D1Database, { redirect, org }: Frame) {
  if (!fits(HTTP, redirect)) throw new Refusal(BAD_FRAME, "нет redirect — адреса пульта");
  if (org !== undefined && !fits(ORG, org)) throw new Refusal(BAD_FRAME, "org — не имя организации");
  const app = await readApp(db);
  if (!app) return { app: null, form: manifestForm(redirect, org) };
  const auth = jwt(app);
  const repos: string[] = [];
  for (const { id } of await pages("/app/installations", auth, (list: { id: number }[]) => list)) {
    const { token } = await issue(id, auth, { permissions: { metadata: "read" } });
    repos.push(...(await pages("/installation/repositories", `token ${token}`, (p: { repositories: { full_name: string }[] }) => p.repositories.map((r) => r.full_name))));
  }
  return { app: { id: app.id, slug: app.slug, owner: app.owner }, repos: repos.sort(), install: installUrl(app.slug) };
}

/** Одноразовый code → приложение с ключом. Остальные секреты ответа не нужны: входа через GitHub и вебхуков у флота нет. */
async function setup(db: D1Database, { code, replace, from }: Frame) {
  if (!fits(CODE, code)) throw new Refusal(BAD_FRAME, "нет code из возврата GitHub");
  const had = await readApp(db);
  if (had && replace !== true) throw new Refusal("app_exists", "приложение уже есть; заменить — replace: true", { app: { id: had.id, slug: had.slug } });
  const { id, slug, owner, pem } = json<{ id: number; slug: string; owner: { login: string }; pem: string }>(await call("POST", `/app-manifests/${code}/conversions`));
  await db.prepare("INSERT OR REPLACE INTO app (one, id, slug, owner, pem, at, by) VALUES (1, ?, ?, ?, ?, ?, ?)").bind(id, slug, owner.login, pem, Date.now(), from).run();
  log("note", "github.setup", { from, app: id, slug, owner: owner.login, replaced: !!had });
  return { app: { id, slug, owner: owner.login }, install: installUrl(slug) };
}

/** Токен только к этому репозиторию и только на содержимое. */
async function token(db: D1Database, { repo, from }: Frame) {
  if (!fits(REPO, repo)) throw new Refusal(BAD_FRAME, "repo — не вида владелец/имя");
  const app = await readApp(db);
  if (!app) throw new Refusal("no_app", "приложения ещё нет: github.setup не делали");
  const auth = jwt(app);
  const found = await call("GET", `/repos/${repo}/installation`, auth);
  if (found.status === 404) throw new Refusal("not_installed", `приложение не допущено к ${repo}`, { install: installUrl(app.slug) });
  const { id } = json<{ id: number }>(found);
  const { token: value, expires_at } = await issue(id, auth, { repositories: [repo.split("/")[1]], permissions: { contents: "write" } });
  log("note", "github.token", { from, repo, installation: id });
  return { token: value, expires_at };
}

const HANDLERS: Record<keyof typeof CONTRACT, (db: D1Database, f: Frame) => Promise<unknown>> = { "github.app": appInfo, "github.setup": setup, "github.token": token };

/** Кадр → ответ. Отказ — Refusal: строка журнала и ответ со словом здесь; остальное летит дальше, вход отвечает failed. */
async function serve(db: D1Database, f: Frame): Promise<Frame[]> {
  const { id, from, repo } = f;
  try {
    const off = accepts(f, CONTRACT);
    if (off) throw new Refusal(off.word, off.why);
    if (!id) throw new Refusal(BAD_FRAME, `${f.type} без id — ответить некому`);
    return [{ ...ok(id, await HANDLERS[f.type as keyof typeof CONTRACT](db, f)), to: from }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    log("refuse", f.type, { word: e.word, why: e.message, from, repo, ...e.row });
    return id ? [{ ...fail(id, e.word), ...e.reply, to: from }] : [];
  }
}

export default {
  fetch: (req, env) => entrance(req, env.GATE, (f) => serve(env.DB, f)),
} satisfies ExportedHandler<Env>;
