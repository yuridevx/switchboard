// Объект приложения GitHub: одна запись app в хранилище; github.app, github.setup, github.token.
// Токенов, установок и репозиториев не хранит: их github спрашивает у GitHub на каждый запрос.
import { DurableObject } from "cloudflare:workers";
import { fail, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT, type AppInfo } from "../contract.ts";
import type { Env } from "./env.ts";
import { appJwt } from "./jwt.ts";
import { log } from "./log.ts";

export const API = "https://api.github.com";

/** Запись приложения: ключ приложения — только здесь; в ответы, кадры и журнал не попадает. */
export type Stored = { id: number; slug: string; owner: string; pem: string; at: number; by: string };

/** GitHub ответил не тем: статус и текст — в журнал, отправителю — github_failed. */
class Failed extends Error {
  status: number;
  text: string;
  constructor(status: number, text: string) {
    super(status ? `GitHub ответил ${status}` : `GitHub недоступен: ${text}`);
    this.status = status;
    this.text = text;
  }
}

// владелец/имя; имя не «.» и не «..»
const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const CODE = /^[A-Za-z0-9_-]+$/;

export class App extends DurableObject<Env> {
  /** Кадр с to: "github" → кадры, которые github шлёт в ответ. */
  async frame(f: Frame): Promise<Frame[]> {
    const from = f.from ?? "";
    const answer = (r: Frame): Frame[] => (f.id ? [{ ...r, to: from }] : []);
    const refuse = (word: string, why: string, extra: Record<string, unknown> = {}, more: Record<string, unknown> = {}): Frame[] => {
      log({ kind: "refuse", ev: f.type, word, why, from, ...more });
      return f.id ? answer({ ...fail(f.id, word), ...extra }) : [];
    };

    if (f.type === "reply") {
      log({ kind: "note", ev: "reply", from, why: "github ответов не ждёт" });
      return [];
    }
    const v = (CONTRACT as Record<string, number>)[f.type];
    if (v === undefined) return refuse("unknown_request", `github не обслуживает ${f.type}`);
    if (f.v !== undefined && f.v !== v) return refuse("contract_mismatch", `${f.type} v${f.v} — у github v${v}`);
    if (!f.id) return refuse("bad_frame", `${f.type} без id — ответить некому`);
    const id = f.id;

    try {
      const app = await this.ctx.storage.get<Stored>("app");
      switch (f.type) {
        case "github.app": {
          if (typeof f.redirect !== "string" || !/^https?:\/\//.test(f.redirect)) return refuse("bad_frame", "нет redirect — адреса пульта");
          if (f.org !== undefined && (typeof f.org !== "string" || !/^[A-Za-z0-9-]+$/.test(f.org))) return refuse("bad_frame", "org — не имя организации");
          if (!app) return answer(ok(id, { app: null, form: form(f.redirect, f.org as string | undefined) }));
          return answer(ok(id, { app: info(app), repos: await repos(app), install: install(app) }));
        }

        case "github.setup": {
          if (typeof f.code !== "string" || !CODE.test(f.code)) return refuse("bad_frame", "нет code из возврата GitHub");
          if (app && f.replace !== true) return refuse("app_exists", "приложение уже есть; заменить — replace: true", { app: { id: app.id, slug: app.slug } });
          const r = await gh(`/app-manifests/${f.code}/conversions`, { method: "POST" });
          if (r.status !== 201) throw new Failed(r.status, await r.text());
          const g = (await r.json()) as { id: number; slug: string; owner?: { login?: string }; pem: string };
          // client_secret и webhook_secret не сохраняются: входа через GitHub и вебхуков у флота нет
          const next: Stored = { id: g.id, slug: g.slug, owner: g.owner?.login ?? "", pem: g.pem, at: Date.now(), by: from };
          await this.ctx.storage.put("app", next);
          log({ kind: "note", ev: f.type, from, app: next.id, slug: next.slug, owner: next.owner, replaced: !!app });
          return answer(ok(id, { app: info(next), install: install(next) }));
        }

        case "github.token": {
          if (typeof f.repo !== "string" || !REPO.test(f.repo)) return refuse("bad_frame", "repo — не вида владелец/имя");
          if (!app) return refuse("no_app", "приложения ещё нет: github.setup не делали");
          const jwt = await appJwt(app.id, app.pem, Date.now());
          const r = await gh(`/repos/${f.repo}/installation`, {}, `Bearer ${jwt}`);
          if (r.status === 404) {
            await r.body?.cancel();
            return refuse("not_installed", `приложение не допущено к ${f.repo}`, { install: install(app) }, { repo: f.repo });
          }
          if (r.status !== 200) throw new Failed(r.status, await r.text());
          const inst = (await r.json()) as { id: number };
          const name = f.repo.split("/")[1];
          const t = await gh(
            `/app/installations/${inst.id}/access_tokens`,
            { method: "POST", body: JSON.stringify({ repositories: [name], permissions: { contents: "write" } }) },
            `Bearer ${jwt}`,
          );
          if (t.status !== 201) throw new Failed(t.status, await t.text());
          const tok = (await t.json()) as { token: string; expires_at: string };
          log({ kind: "note", ev: f.type, from, repo: f.repo, installation: inst.id });
          return answer(ok(id, { token: tok.token, expires_at: tok.expires_at }));
        }
      }
    } catch (e) {
      if (e instanceof Failed) return refuse("github_failed", e.message, {}, { status: e.status, text: e.text });
      throw e;
    }
    return refuse("unknown_request", `github не обслуживает ${f.type}`);
  }
}

function info(a: Stored): AppInfo {
  return { id: a.id, slug: a.slug, owner: a.owner };
}

function install(a: Stored): string {
  return `https://github.com/apps/${a.slug}/installations/new`;
}

/** Форма manifest: закрытое приложение, содержимое репозиториев на запись, без вебхуков. */
export function form(redirect: string, org?: string) {
  return {
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
  };
}

/** Репозитории всех установок: токен установки на чтение метаданных → её репозитории, все страницы. */
async function repos(app: Stored): Promise<string[]> {
  const jwt = await appJwt(app.id, app.pem, Date.now());
  const out: string[] = [];
  for (const inst of await pages<{ id: number }>("/app/installations", `Bearer ${jwt}`, (b) => b as Array<{ id: number }>)) {
    const t = await gh(`/app/installations/${inst.id}/access_tokens`, { method: "POST", body: JSON.stringify({ permissions: { metadata: "read" } }) }, `Bearer ${jwt}`);
    if (t.status !== 201) throw new Failed(t.status, await t.text());
    const { token } = (await t.json()) as { token: string };
    const list = await pages("/installation/repositories", `token ${token}`, (b) => (b as { repositories: Array<{ full_name: string }> }).repositories);
    for (const repo of list) out.push(repo.full_name);
  }
  return out.sort();
}

/** Список GitHub по страницам по 100, пока страница не короче. */
async function pages<T>(path: string, auth: string, items: (body: unknown) => T[]): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const r = await gh(`${path}?per_page=100&page=${page}`, {}, auth);
    if (r.status !== 200) throw new Failed(r.status, await r.text());
    const got = items(await r.json());
    out.push(...got);
    if (got.length < 100) return out;
  }
}

/** Запрос к API GitHub. Нет ответа (сеть) — Failed со статусом 0. */
async function gh(path: string, init: RequestInit, auth?: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "switchboard-github",
    "x-github-api-version": "2022-11-28",
  };
  if (auth) headers.authorization = auth;
  if (init.body) headers["content-type"] = "application/json";
  try {
    return await fetch(API + path, { ...init, headers });
  } catch (e) {
    throw new Failed(0, String(e));
  }
}
