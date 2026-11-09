// GitHub: приложение флота и токен на один репозиторий на час — для кусочков профилей. Ключ приложения — только в записях модуля; токенов модуль не хранит.
import { createSign } from "node:crypto";
import { CALL_MS, Refusal } from "@sb/protocol";
import type { Ctx, Env, Module } from "../env.ts";
import { records } from "../records.ts";

const NAME = "github";
const SCHEMA = ["CREATE TABLE IF NOT EXISTS app (one INTEGER PRIMARY KEY CHECK (one = 1), id INTEGER, slug TEXT, owner TEXT, pem TEXT, at INTEGER, by TEXT)"];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

type App = { id: number; slug: string; owner: string; pem: string };
type Answer = { ok: boolean; status: number; text: string };

const PAGE = 100;
const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/;
const ORG = /^[A-Za-z0-9-]+$/;
const CODE = /^[\w-]+$/;

/** Запрос к API с пределом. Тело читается здесь же: обрыв на нём — тот же отказ, что обрыв на запросе. */
async function api(f: typeof fetch, method: "GET" | "POST", path: string, auth?: string, body?: object): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": "switchboard-github", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (auth) headers.authorization = auth;
  if (body) headers["content-type"] = "application/json";
  try {
    const r = await f(`https://api.github.com${path}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    throw new Refusal("github_failed", `GitHub недоступен: ${e}`);
  }
}

function json<T>({ ok, status, text }: Answer): T {
  if (!ok) throw new Refusal("github_failed", `GitHub ответил ${status}`);
  return JSON.parse(text) as T;
}

/** Все страницы по 100, пока страница не короче. */
async function pages<P, T>(f: typeof fetch, path: string, auth: string, items: (page: P) => T[]): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const got = items(json<P>(await api(f, "GET", `${path}?per_page=${PAGE}&page=${page}`, auth)));
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
const readApp = (ctx: Ctx) => db(ctx.env, ctx.fleet).first<App>("SELECT id, slug, owner, pem FROM app WHERE one = 1");
const issue = async (f: typeof fetch, installation: number, auth: string, body: object) => json<{ token: string; expires_at: string }>(await api(f, "POST", `/app/installations/${installation}/access_tokens`, auth, body));

/** Форма для браузера: закрытое приложение с записью содержимого, без вебхуков. */
const manifestForm = (redirect: string, org?: string) => ({
  action: org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new",
  manifest: {
    name: org ? `Switchboard ${org}` : "Switchboard",
    url: redirect, public: false, redirect_url: redirect, setup_url: redirect,
    hook_attributes: { url: redirect, active: false },
    default_permissions: { contents: "write", metadata: "read" },
    default_events: [],
  },
});

export const github: Module = {
  name: NAME,
  handlers: {
    async "github.app"(_i, ctx) {
      const app = await readApp(ctx);
      if (!app) return { installed: false };
      const auth = jwt(app);
      const repos: string[] = [];
      for (const { id } of await pages(ctx.fetch, "/app/installations", auth, (list: { id: number }[]) => list)) {
        const { token } = await issue(ctx.fetch, id, auth, { permissions: { metadata: "read" } });
        repos.push(...(await pages(ctx.fetch, "/installation/repositories", `token ${token}`, (p: { repositories: { full_name: string }[] }) => p.repositories.map((r) => r.full_name))));
      }
      return { installed: true, name: app.slug, url: installUrl(app.slug), repos: repos.sort() };
    },

    /** Без code — форма создания приложения для браузера; с code из возврата GitHub — приложение с ключом. */
    async "github.setup"(i: { code?: string; redirect?: string; org?: string; replace?: boolean }, ctx) {
      const had = await readApp(ctx);
      if (!i.code) {
        if (had && !i.replace) return { installed: true, url: installUrl(had.slug) };
        if (i.org !== undefined && !ORG.test(i.org)) throw new Refusal("bad_input", "org — не имя организации");
        return { installed: false, form: manifestForm(i.redirect ?? ctx.origin, i.org) };
      }
      if (!CODE.test(i.code)) throw new Refusal("bad_input", "code — не из возврата GitHub");
      if (had && !i.replace) throw new Refusal("app_exists", "приложение уже есть; заменить — replace: true");
      const { id, slug, owner, pem } = json<{ id: number; slug: string; owner: { login: string }; pem: string }>(await api(ctx.fetch, "POST", `/app-manifests/${i.code}/conversions`));
      await db(ctx.env, ctx.fleet).run("INSERT OR REPLACE INTO app (one, id, slug, owner, pem, at, by) VALUES (1, ?, ?, ?, ?, ?, ?)", id, slug, owner.login, pem, Date.now(), ctx.who.addr);
      ctx.log.info("приложение GitHub заведено", { from: ctx.who.addr, app: id, slug, replaced: !!had });
      return { installed: true, url: installUrl(slug) };
    },

    /** Токен только к этому репозиторию и только на содержимое. */
    async "github.token"(i: { repo: string }, ctx) {
      if (!REPO.test(i.repo)) throw new Refusal("bad_input", "repo — не вида владелец/имя");
      const app = await readApp(ctx);
      if (!app) throw new Refusal("no_app", "приложения ещё нет: github.setup не делали");
      const auth = jwt(app);
      const found = await api(ctx.fetch, "GET", `/repos/${i.repo}/installation`, auth);
      if (found.status === 404) throw new Refusal("not_installed", `приложение не допущено к ${i.repo}: ${installUrl(app.slug)}`);
      const { id } = json<{ id: number }>(found);
      const { token, expires_at } = await issue(ctx.fetch, id, auth, { repositories: [i.repo.split("/")[1]], permissions: { contents: "write" } });
      ctx.log.info("токен GitHub выдан", { from: ctx.who.addr, repo: i.repo });
      return { token, expires: Date.parse(expires_at) };
    },
  },
};
