// Worker github: кадр с пропуском → обработчик; приложение флота — одна строка таблицы app, токенов модуль не хранит.
import { entrance, type GateApi } from "@switchboard/gate";
import { accepts, fail, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT, type AppInfo } from "../contract.ts";
import { Refusal, allRepos, convert, installUrl, manifestForm, repoToken } from "./github.ts";

type Env = { DB: D1Database; GATE: GateApi };

/** Журнал — Workers Logs, строка JSON в общем формате журналов. Токенов и ключей здесь нет. */
const log = (row: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "github", ...row }));

const readApp = (db: D1Database) => db.prepare("SELECT id, slug, owner, pem FROM app WHERE one = 1").first<AppInfo & { pem: string }>();
const info = ({ id, slug, owner }: AppInfo): AppInfo => ({ id, slug, owner });

const ORG = /^[A-Za-z0-9-]+$/;
const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/;
const CODE = /^[\w-]+$/;

const HANDLERS: Record<keyof typeof CONTRACT, (f: Frame, db: D1Database) => Promise<unknown>> = {
  async "github.app"({ redirect, org }, db) {
    if (typeof redirect !== "string" || !/^https?:\/\//.test(redirect)) throw new Refusal("bad_frame", "нет redirect — адреса пульта");
    if (org !== undefined && (typeof org !== "string" || !ORG.test(org))) throw new Refusal("bad_frame", "org — не имя организации");
    const app = await readApp(db);
    if (!app) return { app: null, form: manifestForm(redirect, org) };
    return { app: info(app), repos: await allRepos(app), install: installUrl(app.slug) };
  },

  async "github.setup"({ code, replace, from }, db) {
    if (typeof code !== "string" || !CODE.test(code)) throw new Refusal("bad_frame", "нет code из возврата GitHub");
    const had = await readApp(db);
    if (had && replace !== true) throw new Refusal("app_exists", "приложение уже есть; заменить — replace: true", { app: { id: had.id, slug: had.slug } });
    const app = await convert(code);
    await db.prepare("INSERT OR REPLACE INTO app (one, id, slug, owner, pem, at, by) VALUES (1, ?, ?, ?, ?, ?, ?)").bind(app.id, app.slug, app.owner, app.pem, Date.now(), from).run();
    log({ kind: "note", ev: "github.setup", from, app: app.id, slug: app.slug, owner: app.owner, replaced: !!had });
    return { app: info(app), install: installUrl(app.slug) };
  },

  async "github.token"({ repo, from }, db) {
    if (typeof repo !== "string" || !REPO.test(repo)) throw new Refusal("bad_frame", "repo — не вида владелец/имя");
    const app = await readApp(db);
    if (!app) throw new Refusal("no_app", "приложения ещё нет: github.setup не делали");
    const got = await repoToken(app, repo);
    if (!got) throw new Refusal("not_installed", `приложение не допущено к ${repo}`, { install: installUrl(app.slug) });
    log({ kind: "note", ev: "github.token", from, repo, installation: got.installation });
    return { token: got.token, expires_at: got.expires_at };
  },
};

/** Кадр → ответ. Отказ — Refusal: строка журнала и ответ со словом здесь; остальное летит дальше, вход отвечает failed. */
async function frame(f: Frame, db: D1Database): Promise<Frame[]> {
  const { id, from, repo } = f;
  try {
    const off = accepts(f, CONTRACT);
    if (off) throw new Refusal(off.word, off.why);
    if (!id) throw new Refusal("bad_frame", `${f.type} без id — ответить некому`);
    return [{ ...ok(id, await HANDLERS[f.type as keyof typeof CONTRACT](f, db)), to: from }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    log({ kind: "refuse", ev: f.type, word: e.word, why: e.message, from, repo, ...e.row });
    return id ? [{ ...fail(id, e.word), ...e.reply, to: from }] : [];
  }
}

export default {
  fetch: (req, env) => entrance(req, env.GATE, (f) => frame(f, env.DB)),
} satisfies ExportedHandler<Env>;
