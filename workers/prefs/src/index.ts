// Worker prefs: POST кадра с пропуском → строка таблицы или слово отказа. Значение служба хранит как JSON и не разбирает.
import { entrance } from "@switchboard/gate";
import type { GateApi } from "@switchboard/gate";
import { accepts, fail, ok, userOf, type Frame } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";

type Env = { DB: D1Database; GATE: GateApi };

/** Предел строки в D1. */
const MAX_VALUE = 2_000_000;
const APP_SCOPE = /^app:[\w-]+$/;

class Refusal extends Error {
  readonly word: string;
  readonly why: string;

  constructor(word: string, why: string) {
    super(`${word}: ${why}`);
    this.word = word;
    this.why = why;
  }
}
const refuse = (word: string, why: string): never => {
  throw new Refusal(word, why);
};

/** Владелец строки: область кадра, а без неё — человек из адреса отправителя. */
function ownerOf({ scope, from = "" }: Frame): string {
  if (scope === undefined) return userOf(from) ?? refuse("not_user", `${from} — не человек и не его устройство`);
  if (scope === "global" || (typeof scope === "string" && APP_SCOPE.test(scope))) return scope;
  return refuse("bad_frame", `область ${JSON.stringify(scope)}: нужно global или app:<приложение>`);
}

async function read(db: D1Database, owner: string, f: Frame) {
  const { prefix = "" } = f;
  if (f.prefix !== undefined && (typeof prefix !== "string" || !prefix)) refuse("bad_frame", "prefix — непустая строка");
  // substr, а не LIKE: знаки шаблона в prefix буквальны
  const { results } = await db.prepare("SELECT key, value FROM prefs WHERE user = ?1 AND substr(key, 1, length(?2)) = ?2").bind(owner, prefix).all<{ key: string; value: string }>();
  return { values: Object.fromEntries(results.map((r) => [r.key, JSON.parse(r.value)])) };
}

async function write(db: D1Database, owner: string, f: Frame) {
  const { name, value } = f;
  if (typeof name !== "string" || !name) return refuse("bad_frame", "в prefs.set нет name");
  if (value === undefined) return refuse("bad_frame", `в prefs.set ${name} нет value`);
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_VALUE) refuse("too_large", `${name}: ${bytes} байт, предел ${MAX_VALUE}`);
  await db.prepare("INSERT OR REPLACE INTO prefs (user, key, value) VALUES (?, ?, ?)").bind(owner, name, text).run();
  return undefined;
}

async function serve(db: D1Database, f: Frame): Promise<Frame[]> {
  const to = f.from ?? "";
  try {
    const bad = accepts(f, CONTRACT);
    if (bad) refuse(bad.word, bad.why);
    if (!f.id) return refuse("bad_frame", `${f.type} без id — ответить некому`);
    return [{ ...ok(f.id, await (f.type === "prefs.get" ? read : write)(db, ownerOf(f), f)), to }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.log(JSON.stringify({ t: new Date().toISOString(), part: "prefs", kind: "refuse", ev: f.type, word: e.word, why: e.why, from: to }));
    return f.id ? [{ ...fail(f.id, e.word), to }] : [];
  }
}

export default {
  fetch: (req, env) => entrance(req, env.GATE, (f) => serve(env.DB, f)),
} satisfies ExportedHandler<Env>;
