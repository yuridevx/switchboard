// Настройки над базой D1: одна таблица, строка на ключ. Владелец строки — область: почта отправителя (только из адреса), global или app:<приложение>.
// Значений служба не читает, в журнал они не попадают: новая настройка страницы сервера не меняет.
import { accepts, fail, ok, userOf, type Frame } from "@switchboard/protocol";
import type { GateApi } from "@switchboard/gate";
import { CONTRACT } from "../contract.ts";

export interface Env {
  /** настройки — своя база D1, отдельно от служебных баз флота */
  DB: D1Database;
  /** gate: пропуск прямого запроса */
  GATE: GateApi;
}

/** Столько байт D1 принимает в строке. */
const VALUE_MAX = 2_000_000;
const APP_SCOPE = /^app:[A-Za-z0-9_-]+$/;

type Refusal = { word: string; why: string };
type Done = { result?: unknown };

const refusal = (word: string, why: string): Refusal => ({ word, why });

/** Чья строка: область из кадра, иначе человек отправителя. Машине и сессии доступна только общая область. */
function ownerOf(f: Frame): string | Refusal {
  const { scope, from = "" } = f;
  if (scope === undefined) return userOf(from) ?? refusal("not_user", `${from} — не человек и не его устройство`);
  if (scope === "global" || (typeof scope === "string" && APP_SCOPE.test(scope))) return scope as string;
  return refusal("bad_frame", `область ${JSON.stringify(scope)}: нужно global или app:<приложение>`);
}

async function readValues(db: D1Database, owner: string, f: Frame): Promise<Done | Refusal> {
  const { prefix } = f;
  if (prefix !== undefined && (typeof prefix !== "string" || !prefix)) return refusal("bad_frame", "prefix — непустая строка");
  const query =
    prefix === undefined
      ? db.prepare("SELECT key, value FROM prefs WHERE user = ?").bind(owner)
      : db.prepare("SELECT key, value FROM prefs WHERE user = ? AND substr(key, 1, ?) = ?").bind(owner, (prefix as string).length, prefix);
  const { results } = await query.all<{ key: string; value: string }>();
  return { result: { values: Object.fromEntries(results.map((row) => [row.key, JSON.parse(row.value)])) } };
}

async function writeValue(db: D1Database, owner: string, f: Frame): Promise<Done | Refusal> {
  const { name, value } = f;
  if (typeof name !== "string" || !name) return refusal("bad_frame", "в prefs.set нет name");
  if (value === undefined) return refusal("bad_frame", `в prefs.set ${name} нет value`);
  const stored = JSON.stringify(value);
  const bytes = new TextEncoder().encode(stored).length;
  if (bytes > VALUE_MAX) return refusal("too_large", `${name}: ${bytes} байт, предел ${VALUE_MAX}`);
  await db.prepare("INSERT INTO prefs (user, key, value) VALUES (?, ?, ?) ON CONFLICT (user, key) DO UPDATE SET value = excluded.value").bind(owner, name, stored).run();
  return {};
}

async function perform(db: D1Database, f: Frame): Promise<Done | Refusal> {
  const bad = accepts(f, CONTRACT);
  if (bad) return refusal(bad.word, bad.why);
  if (!f.id) return refusal("bad_frame", `${f.type} без id — ответить некому`);
  const owner = ownerOf(f);
  if (typeof owner !== "string") return owner;
  return f.type === "prefs.get" ? readValues(db, owner, f) : writeValue(db, owner, f);
}

/** Кадр с to: ".prefs" → ответ отправителю; отказ — словом и строкой журнала Workers Logs. */
export async function frame(env: Env, f: Frame): Promise<Frame[]> {
  const from = f.from ?? "";
  const done = await perform(env.DB, f);
  if ("word" in done) {
    console.log(JSON.stringify({ t: new Date().toISOString(), part: "prefs", kind: "refuse", ev: f.type, word: done.word, why: done.why, from }));
    return f.id ? [{ ...fail(f.id, done.word), to: from }] : [];
  }
  return [{ ...ok(f.id as string, done.result), to: from }];
}
