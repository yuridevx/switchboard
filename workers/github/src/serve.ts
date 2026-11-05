// Кадр с to: ".github" → кадры в ответ. Приложение GitHub флота — одна строка таблицы; токенов, установок и репозиториев
// модуль не хранит: спрашивает у GitHub на каждый запрос.
import { accepts, fail, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT, type AppInfo } from "../contract.ts";
import type { Env } from "./env.ts";
import { createdApp, creationForm, installedRepos, installUrl, repoToken } from "./github.ts";
import { appJwt } from "./jwt.ts";
import { log } from "./log.ts";
import { Refusal } from "./refusal.ts";
import { readApp, saveApp, type AppRow } from "./store.ts";

// владелец/имя; имя не «.» и не «..»
const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const CODE = /^[A-Za-z0-9_-]+$/;
const ORG = /^[A-Za-z0-9-]+$/;
const WEB_ADDRESS = /^https?:\/\//;

const info = ({ id, slug, owner }: AppRow): AppInfo => ({ id, slug, owner });
const jwtOf = (app: AppRow) => appJwt(app.id, app.pem, Date.now());

async function describeApp(env: Env, f: Frame): Promise<unknown> {
  if (typeof f.redirect !== "string" || !WEB_ADDRESS.test(f.redirect)) throw new Refusal("bad_frame", "нет redirect — адреса пульта");
  if (f.org !== undefined && (typeof f.org !== "string" || !ORG.test(f.org))) throw new Refusal("bad_frame", "org — не имя организации");
  const app = await readApp(env.DB);
  if (!app) return { app: null, form: creationForm(f.redirect, f.org as string | undefined) };
  return { app: info(app), repos: await installedRepos(await jwtOf(app)), install: installUrl(app.slug) };
}

async function setUp(env: Env, f: Frame): Promise<unknown> {
  if (typeof f.code !== "string" || !CODE.test(f.code)) throw new Refusal("bad_frame", "нет code из возврата GitHub");
  const previous = await readApp(env.DB);
  if (previous && f.replace !== true) throw new Refusal("app_exists", "приложение уже есть; заменить — replace: true", { reply: { app: { id: previous.id, slug: previous.slug } } });
  const app: AppRow = { ...(await createdApp(f.code)), at: Date.now(), by: f.from ?? "" };
  await saveApp(env.DB, app);
  log({ kind: "note", ev: f.type, from: app.by, app: app.id, slug: app.slug, owner: app.owner, replaced: !!previous });
  return { app: info(app), install: installUrl(app.slug) };
}

async function issueToken(env: Env, f: Frame): Promise<unknown> {
  if (typeof f.repo !== "string" || !REPO.test(f.repo)) throw new Refusal("bad_frame", "repo — не вида владелец/имя");
  const app = await readApp(env.DB);
  if (!app) throw new Refusal("no_app", "приложения ещё нет: github.setup не делали");
  const issued = await repoToken(await jwtOf(app), f.repo);
  if (!issued) throw new Refusal("not_installed", `приложение не допущено к ${f.repo}`, { reply: { install: installUrl(app.slug) }, journal: { repo: f.repo } });
  log({ kind: "note", ev: f.type, from: f.from ?? "", repo: f.repo, installation: issued.installation });
  return { token: issued.token, expires_at: issued.expires_at };
}

const REQUESTS: Record<keyof typeof CONTRACT, (env: Env, f: Frame) => Promise<unknown>> = {
  "github.app": describeApp,
  "github.setup": setUp,
  "github.token": issueToken,
};

export async function serve(env: Env, f: Frame): Promise<Frame[]> {
  const from = f.from ?? "";
  // ответов github не ждёт; отказ на ответ породил бы ответ на отказ
  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", from, why: "github ответов не ждёт" });
    return [];
  }
  try {
    const bad = accepts(f, CONTRACT);
    if (bad) throw new Refusal(bad.word, bad.why);
    if (!f.id) throw new Refusal("bad_frame", `${f.type} без id — ответить некому`);
    return [{ ...ok(f.id, await REQUESTS[f.type as keyof typeof CONTRACT](env, f)), to: from }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    log({ kind: "refuse", ev: f.type, word: e.word, why: e.why, from, ...e.parts.journal });
    return f.id ? [{ ...fail(f.id, e.word), ...e.parts.reply, to: from }] : [];
  }
}
