// GitHub: приложение флота и токен на один репозиторий на час — для кусочков профилей. Ключ приложения — только в записях модуля; токенов модуль не хранит.
// Приложение подписано на события своих репозиториев: секрет подписи лежит здесь же, подпись сверяет и событие разбирает этот модуль —
// второго владельца секретов и формата GitHub нет.
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { CALL_MS, Refusal } from "@sb/protocol";
import type { Ctx, Env, Module } from "../../env.ts";
import { type Op, records } from "../../records.ts";

const NAME = "github";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS app (one INTEGER PRIMARY KEY CHECK (one = 1), id INTEGER, slug TEXT, owner TEXT, pem TEXT, at INTEGER, by TEXT)",
  // секрет подписи событий приложения: его называет GitHub при создании приложения
  "CREATE TABLE IF NOT EXISTS hook (one INTEGER PRIMARY KEY CHECK (one = 1), secret TEXT NOT NULL)",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

type App = { id: number; slug: string; owner: string; pem: string };
/** Чем модуль ходит в сеть и в свои записи: запрос человека (Ctx) или срок часов — у обоих окружение, флот и сеть. */
export type Net = Pick<Ctx, "env" | "fleet" | "fetch">;
type Answer = { ok: boolean; status: number; text: string; etag?: string };

const PAGE = 100;
const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/;
const ORG = /^[A-Za-z0-9-]+$/;
const CODE = /^[\w-]+$/;

/** Запрос к API с пределом. Тело читается здесь же: обрыв на нём — тот же отказ, что обрыв на запросе. */
async function api(ctx: Net, method: "GET" | "POST", path: string, auth?: string, body?: object, etag?: string): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": "switchboard-github", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (auth) headers.authorization = auth;
  // условный запрос: ответ «не изменилось» (304) в предел запросов GitHub не идёт
  if (etag) headers["if-none-match"] = etag;
  if (body) headers["content-type"] = "application/json";
  try {
    // адрес API GitHub: по умолчанию — сам GitHub; GITHUB_API — другой сервер с тем же API
    const r = await ctx.fetch(`${(ctx.env.GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "")}${path}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
    return { ok: r.ok, status: r.status, text: await r.text(), ...(r.headers.get("etag") ? { etag: r.headers.get("etag")! } : {}) };
  } catch (e) {
    throw new Refusal("github_failed", `GitHub недоступен: ${e}`);
  }
}

function json<T>({ ok, status, text }: Answer): T {
  if (!ok) throw new Refusal("github_failed", `GitHub ответил ${status}`);
  return JSON.parse(text) as T;
}

/** Все страницы по 100, пока страница не короче. */
async function pages<P, T>(ctx: Net, path: string, auth: string, items: (page: P) => T[]): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const got = items(json<P>(await api(ctx, "GET", `${path}?per_page=${PAGE}&page=${page}`, auth)));
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
const readApp = (ctx: Net) => db(ctx.env, ctx.fleet).first<App>("SELECT id, slug, owner, pem FROM app WHERE one = 1");
const issue = async (ctx: Net, installation: number, auth: string, body: object) => json<{ token: string; expires_at: string }>(await api(ctx, "POST", `/app/installations/${installation}/access_tokens`, auth, body));

/** Доступ на чтение чужого репозитория: токен установки приложения в своём репозитории проекта — публичное видно любому токену.
 *  Токен живёт час и не хранится: на каждый опрос — свой. */
export async function reader(ctx: Net, own: string): Promise<string> {
  const app = await readApp(ctx);
  if (!app) throw new Refusal("no_app", "приложения ещё нет: github.setup не делали");
  const auth = jwt(app);
  const found = await api(ctx, "GET", `/repos/${own}/installation`, auth);
  if (found.status === 404) throw new Refusal("not_installed", `приложение не допущено к ${own}: ${installUrl(app.slug)}`);
  return `token ${(await issue(ctx, json<{ id: number }>(found).id, auth, { repositories: [own.split("/")[1]], permissions: { metadata: "read" } })).token}`;
}

/** Голова основной ветки репозитория. etag — отпечаток прошлого ответа: голова прежняя — null, и запрос в предел GitHub не идёт. */
export async function head(ctx: Net, auth: string, repo: string, etag?: string): Promise<{ sha: string; etag?: string } | null> {
  const got = await api(ctx, "GET", `/repos/${repo}/commits/HEAD`, auth, undefined, etag);
  if (got.status === 304) return null;
  return { sha: json<{ sha: string }>(got).sha, ...(got.etag ? { etag: got.etag } : {}) };
}

/** PR чужого репозитория глазами флота: открыт, слит или закрыт; review — последнее ревью с просьбой правок: его номер и слова. */
export async function pull(ctx: Net, auth: string, pr: string): Promise<{ state: "open" | "merged" | "closed"; review?: { id: number; text: string; by: string } }> {
  const [repo, n] = pr.split("#");
  const p = json<{ state: string; merged?: boolean }>(await api(ctx, "GET", `/repos/${repo}/pulls/${n}`, auth));
  if (p.merged) return { state: "merged" };
  if (p.state === "closed") return { state: "closed" };
  const asked = (await pages(ctx, `/repos/${repo}/pulls/${n}/reviews`, auth, (list: { id: number; state: string; body?: string | null; user?: { login?: string } }[]) => list)).findLast((r) => r.state === "CHANGES_REQUESTED");
  return { state: "open", ...(asked ? { review: { id: asked.id, text: asked.body ?? "", by: asked.user?.login ?? "" } } : {}) };
}

/** Адрес, на который GitHub шлёт события приложения флота. */
export const eventsPath = (fleet: string) => `/github/${fleet}`;

/** Форма для браузера: закрытое приложение с записью содержимого и чтением PR; события о PR и ревью идут на адрес флота hook. */
const manifestForm = (redirect: string, hook: string, org?: string) => ({
  action: org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new",
  manifest: {
    name: org ? `Switchboard ${org}` : "Switchboard",
    url: redirect, public: false, redirect_url: redirect, setup_url: redirect,
    hook_attributes: { url: hook, active: true },
    default_permissions: { contents: "write", metadata: "read", pull_requests: "read" },
    default_events: ["pull_request", "pull_request_review"],
  },
});

/** Событие GitHub о PR глазами флота: PR (владелец/имя#номер) и чем кончилось — слит, закрыт без слияния или ревью просит правок (text — его слова). */
export type PrEvent = { pr: string; outcome: "merged" | "closed" | "changes"; text: string; by: string };

/** Принятое событие приложения: подпись сверена секретом приложения флота. Ответ — событие о PR или null, если флоту оно ни о чём не говорит.
 *  Секрета нет (приложение создано без событий) или подпись не та — отказ bad_signature. */
export async function received(env: Env, fleet: string, headers: Headers, raw: string): Promise<PrEvent | null> {
  const secret = (await db(env, fleet).first<{ secret: string }>("SELECT secret FROM hook WHERE one = 1"))?.secret;
  if (!secret) throw new Refusal("bad_signature", "приложение GitHub флота не подписано на события");
  const want = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(headers.get("x-hub-signature-256") ?? "");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Refusal("bad_signature", "подпись события не сошлась");
  let x: { action?: string; repository?: { full_name?: string }; sender?: { login?: string }; pull_request?: { number?: number; merged?: boolean }; review?: { state?: string; body?: string | null; user?: { login?: string } } };
  try {
    x = JSON.parse(raw) as typeof x;
  } catch {
    throw new Refusal("bad_frame", "тело события — не JSON");
  }
  const repo = x.repository?.full_name, n = x.pull_request?.number;
  if (!repo || !n) return null;
  const pr = `${repo}#${n}`;
  const kind = headers.get("x-github-event");
  if (kind === "pull_request" && x.action === "closed") return { pr, outcome: x.pull_request!.merged ? "merged" : "closed", text: "", by: x.sender?.login ?? "" };
  if (kind === "pull_request_review" && x.action === "submitted" && x.review?.state === "changes_requested") return { pr, outcome: "changes", text: x.review.body ?? "", by: x.review.user?.login ?? "" };
  return null;
}

/** Файл репозитория на голове его основной ветки — соседнему модулю служб: текст и коммит, с которого он прочитан.
 *  Приложение флота должно быть допущено к репозиторию; файла нет — no_file. */
export async function file(ctx: Net, repo: string, path: string): Promise<{ text: string; commit: string }> {
  if (!REPO.test(repo)) throw new Refusal("bad_input", "repo — не вида владелец/имя");
  const app = await readApp(ctx);
  if (!app) throw new Refusal("no_app", "приложения ещё нет: github.setup не делали");
  const auth = jwt(app);
  const found = await api(ctx, "GET", `/repos/${repo}/installation`, auth);
  if (found.status === 404) throw new Refusal("not_installed", `приложение не допущено к ${repo}: ${installUrl(app.slug)}`);
  const { token } = await issue(ctx, json<{ id: number }>(found).id, auth, { repositories: [repo.split("/")[1]], permissions: { contents: "read" } });
  const head = json<{ sha: string }>(await api(ctx, "GET", `/repos/${repo}/commits/HEAD`, `token ${token}`));
  const got = await api(ctx, "GET", `/repos/${repo}/contents/${path}?ref=${head.sha}`, `token ${token}`);
  if (got.status === 404) throw new Refusal("no_file", `в ${repo} нет файла ${path}`);
  const { content, encoding } = json<{ content: string; encoding?: string }>(got);
  return { text: Buffer.from(content, encoding === "base64" ? "base64" : "utf8").toString("utf8"), commit: head.sha };
}

export const github: Module = {
  name: NAME,
  handlers: {
    async "github.app"(_i, ctx) {
      const app = await readApp(ctx);
      if (!app) return { installed: false };
      const auth = jwt(app);
      const repos: string[] = [];
      for (const { id } of await pages(ctx, "/app/installations", auth, (list: { id: number }[]) => list)) {
        const { token } = await issue(ctx, id, auth, { permissions: { metadata: "read" } });
        repos.push(...(await pages(ctx, "/installation/repositories", `token ${token}`, (p: { repositories: { full_name: string }[] }) => p.repositories.map((r) => r.full_name))));
      }
      const events = !!(await db(ctx.env, ctx.fleet).first("SELECT one FROM hook WHERE one = 1"));
      return { installed: true, name: app.slug, url: installUrl(app.slug), repos: repos.sort(), events };
    },

    /** Без code — форма создания приложения для браузера; с code из возврата GitHub — приложение с ключом. */
    async "github.setup"(i: { code?: string; redirect?: string; org?: string; replace?: boolean }, ctx) {
      const had = await readApp(ctx);
      if (!i.code) {
        if (had && !i.replace) return { installed: true, url: installUrl(had.slug) };
        if (i.org !== undefined && !ORG.test(i.org)) throw new Refusal("bad_input", "org — не имя организации");
        return { installed: false, form: manifestForm(i.redirect ?? ctx.origin, ctx.origin + eventsPath(ctx.fleet), i.org) };
      }
      if (!CODE.test(i.code)) throw new Refusal("bad_input", "code — не из возврата GitHub");
      if (had && !i.replace) throw new Refusal("app_exists", "приложение уже есть; заменить — replace: true");
      const { id, slug, owner, pem, webhook_secret } = json<{ id: number; slug: string; owner: { login: string }; pem: string; webhook_secret?: string | null }>(await api(ctx, "POST", `/app-manifests/${i.code}/conversions`));
      // ключ приложения и секрет подписи его событий — одной пачкой: прежний секрет не переживает замену приложения
      await db(ctx.env, ctx.fleet).batch([
        ["INSERT OR REPLACE INTO app (one, id, slug, owner, pem, at, by) VALUES (1, ?, ?, ?, ?, ?, ?)", id, slug, owner.login, pem, Date.now(), ctx.who.addr],
        ["DELETE FROM hook"],
        ...(webhook_secret ? [["INSERT INTO hook (one, secret) VALUES (1, ?)", webhook_secret] satisfies Op] : []),
      ]);
      ctx.log.info("приложение GitHub заведено", { from: ctx.who.addr, app: id, slug, replaced: !!had });
      return { installed: true, url: installUrl(slug) };
    },

    /** Токен только к этому репозиторию и только на содержимое. */
    async "github.token"(i: { repo: string }, ctx) {
      if (!REPO.test(i.repo)) throw new Refusal("bad_input", "repo — не вида владелец/имя");
      const app = await readApp(ctx);
      if (!app) throw new Refusal("no_app", "приложения ещё нет: github.setup не делали");
      const auth = jwt(app);
      const found = await api(ctx, "GET", `/repos/${i.repo}/installation`, auth);
      if (found.status === 404) throw new Refusal("not_installed", `приложение не допущено к ${i.repo}: ${installUrl(app.slug)}`);
      const { id } = json<{ id: number }>(found);
      const { token, expires_at } = await issue(ctx, id, auth, { repositories: [i.repo.split("/")[1]], permissions: { contents: "write" } });
      ctx.log.info("токен GitHub выдан", { from: ctx.who.addr, repo: i.repo });
      return { token, expires: Date.parse(expires_at) };
    },
  },
};
