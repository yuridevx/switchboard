// Входы: адрес с секретом для событий снаружи. Дело одно — удостовериться в отправителе и отдать событие «Фабрике».
// Секрет — 32 случайных байта в самом адресе /h/<флот>/<секрет>; в записях — только его хэш. У правила один действующий адрес:
// новый отзывает прежний. Правил модуль не знает: есть ли у проекта правило с таким именем, отвечает «Фабрика».
import { errFields, type FileIn, MAX_FRAME, newId, Refusal, sha256hex } from "@sb/protocol";
import { log, outbound, type Deps, type Env, type Module, type Outside } from "../../env.ts";
import { records } from "../../records.ts";
import { line } from "../analytics/contract.ts";
import { event, hookable } from "../factory/contract.ts";
import { store } from "../files/contract.ts";

const NAME = "hooks";
/** От чьего имени событие встаёт в тикет. */
const FROM = ".hooks";
const SCHEMA = ["CREATE TABLE IF NOT EXISTS urls (hash TEXT PRIMARY KEY, project TEXT NOT NULL, rule TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, revoked INTEGER)"];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);
/** Адрес: флот и секрет — 32 байта в base64url, 43 знака. */
const PATH = /^\/h\/([a-z0-9][a-z0-9_-]{0,62})\/([A-Za-z0-9_-]{43})$/i;
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

type Url = { project: string; rule: string; revoked: number | null };
/** Тело события: текст либо JSON с ключом, текстом и файлами содержимым. */
type Body = { key?: string; text: string; files: { name: string; base64: string }[] };

/** Тело запроса → событие. JSON — объект {key, text, files}; всё остальное — текст как есть. */
function parse(type: string, raw: string): Body {
  if (!/^application\/json\b/i.test(type)) return { text: raw, files: [] };
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    throw new Refusal("bad_frame", "тело — не JSON");
  }
  const o = x as { key?: unknown; text?: unknown; files?: unknown };
  const files = o?.files ?? [];
  const isFile = (f: unknown) => !!f && typeof (f as { name?: unknown }).name === "string" && typeof (f as { base64?: unknown }).base64 === "string";
  if (!o || typeof o !== "object" || Array.isArray(o) || (o.text !== undefined && typeof o.text !== "string") || (o.key !== undefined && typeof o.key !== "string") || !Array.isArray(files) || !files.every(isFile))
    throw new Refusal("bad_frame", "тело JSON — объект: text и key — строки, files — список { name, base64 }");
  return { key: o.key as string | undefined, text: (o.text as string | undefined) ?? "", files: files as Body["files"] };
}

/** Запрос на адрес с секретом: POST /h/<флот>/<секрет>. Чужой адрес — 404, отозванный — 410, правила больше нет — 404; принято — 202 с номером тикета.
 *  В журнал и в историю идёт путь без секрета. */
export async function hook(req: Request, env: Env, deps: Deps): Promise<Response> {
  const m = PATH.exec(new URL(req.url).pathname);
  const answer = (status: number, body: object = {}) => Response.json(body, { status });
  if (!m || req.method !== "POST") return answer(404, { error: "not_found" });
  const [, fleet, secret] = m as unknown as [string, string, string];
  const path = `/h/${fleet}/…`;
  const w: Outside = { platform: deps.platform ?? env.PLATFORM, fetch: deps.fetch ?? outbound, log: log.with({ module: NAME, fleet }) };
  const url = await db(env, fleet).first<Url>("SELECT project, rule, revoked FROM urls WHERE hash = ?", await sha256hex(secret));
  if (!url) {
    // флота с таким адресом может и не быть: строка — в журнал служб, а не в историю флота
    w.log.warn("вход: адреса нет", { path });
    return answer(404, { error: "not_found" });
  }
  /** Ответ и строка истории «hook»: путь без секрета, правило и код ответа. */
  const done = async (status: number, body: object, why = "") => {
    await line(env, w.fetch, fleet, { file: NAME, msg: "hook", kind: String(status), level: status < 300 ? "info" : "warn", text: why, data: { path, project: url.project, rule: url.rule, status } }).catch((e: unknown) => w.log.warn("строка истории входа не записалась", errFields(e)));
    return answer(status, body);
  };
  if (url.revoked) return done(410, { error: "gone" }, "адрес отозван");
  try {
    const raw = await req.text();
    if (raw.length > MAX_FRAME) throw new Refusal("too_large", `тело больше ${MAX_FRAME} байт`);
    const body = parse(req.headers.get("content-type") ?? "", raw);
    const files: FileIn[] = [];
    for (const f of body.files) {
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      } catch {
        throw new Refusal("bad_frame", `файл ${f.name}: содержимое — не base64`);
      }
      files.push(await store(env, fleet, f.name, bytes));
    }
    const got = await event(env, w, fleet, { project: url.project, rule: url.rule, source: "hook", key: body.key, text: body.text, files, by: FROM, trace: newId("t") });
    return await done(202, { id: got.id });
  } catch (e) {
    if (e instanceof Refusal) return done(e.word === "no_rule" ? 404 : 400, { error: e.word, why: e.why }, `${e.word}: ${e.why ?? ""}`);
    w.log.error("вход: событие не принято", { path, ...errFields(e) });
    return done(500, { error: "module_failed" }, errFields(e).why);
  }
}

export const hooks: Module = {
  name: NAME,
  handlers: {
    async "hook.url"(i: { project?: string; name: string }, ctx) {
      const project = await hookable(ctx, i.project, i.name);
      const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
      const now = Date.now();
      // у правила один действующий адрес: прежний отозван той же записью
      await db(ctx.env, ctx.fleet).batch([
        ["UPDATE urls SET revoked = ? WHERE project = ? AND rule = ? AND revoked IS NULL", now, project, i.name],
        ["INSERT INTO urls (hash, project, rule, at, by) VALUES (?, ?, ?, ?, ?)", await sha256hex(secret), project, i.name, now, ctx.who.addr],
      ]);
      ctx.log.info("вход: адрес выдан", { module: NAME, project, rule: i.name, from: ctx.who.addr });
      return { url: `${ctx.origin}/h/${ctx.fleet}/${secret}` };
    },
  },
};
