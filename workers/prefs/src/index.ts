// Worker prefs: кадр с пропуском → строки своей базы. Значений не читает; значение в журнал не идёт.
import { entrance, type GateApi } from "@switchboard/gate";
import { accepts, fail, ok, userOf, type Frame } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";

type Env = { DB: D1Database; GATE: GateApi };

/** Предел значения в байтах: больше строки базы D1 не принимает. */
const MAX_VALUE = 2_000_000;
const SCOPE = /^(global|app:[\w-]+)$/;

const text = (v: unknown): v is string => typeof v === "string" && v !== "";

async function frame(f: Frame, db: D1Database): Promise<Frame[]> {
  const { type, id, from, scope, prefix, name, value } = f;
  const refuse = (word: string, why: string) => {
    console.log(JSON.stringify({ t: new Date().toISOString(), part: "prefs", kind: "refuse", ev: type, word, why, from }));
    return id ? [{ ...fail(id, word), to: from }] : [];
  };
  const off = accepts(f, CONTRACT);
  if (off) return refuse(off.word, off.why);
  if (!id) return refuse("bad_frame", `${type} без id — ответить некому`);
  if (scope !== undefined && !(typeof scope === "string" && SCOPE.test(scope))) return refuse("bad_frame", `область ${JSON.stringify(scope)}: нужно global или app:<приложение>`);
  const owner = scope ?? userOf(from!);
  if (!owner) return refuse("not_user", `${from} — не человек и не его устройство`);

  if (type === "prefs.get") {
    if (prefix !== undefined && !text(prefix)) return refuse("bad_frame", "prefix — непустая строка");
    // substr, а не LIKE: знаки шаблона в prefix буквальны
    const { results } = await db.prepare("SELECT key, value FROM prefs WHERE user = ?1 AND substr(key, 1, length(?2)) = ?2").bind(owner, prefix ?? "").all<{ key: string; value: string }>();
    return [{ ...ok(id, { values: Object.fromEntries(results.map((r) => [r.key, JSON.parse(r.value)])) }), to: from }];
  }
  if (!text(name)) return refuse("bad_frame", "в prefs.set нет name");
  if (value === undefined) return refuse("bad_frame", `в prefs.set ${name} нет value`);
  const json = JSON.stringify(value);
  const size = new TextEncoder().encode(json).length;
  if (size > MAX_VALUE) return refuse("too_large", `${name}: ${size} байт, предел ${MAX_VALUE}`);
  await db.prepare("INSERT OR REPLACE INTO prefs (user, key, value) VALUES (?, ?, ?)").bind(owner, name, json).run();
  return [{ ...ok(id), to: from }];
}

export default {
  fetch: (req, env) => entrance(req, env.GATE, (f) => frame(f, env.DB)),
} satisfies ExportedHandler<Env>;
