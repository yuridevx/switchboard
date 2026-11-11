// Worker fleetkeys: кадр с пропуском → строки своей базы. Значения ключей в журнал не идут.
import { entrance, type GateApi } from "@switchboard/gate";
import { accepts, fail, kindOf, ok, within, type Frame } from "@switchboard/protocol";
import { CONTRACT, KEY_NAME, type KeyConfig } from "../contract.ts";

type Env = { DB: D1Database; GATE: GateApi; RELAY: { broadcast(f: Frame): Promise<number> } };
type Row = { name: string; env: string; settings: string; key: string };

const ME = ".fleetkeys";

const line = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "fleetkeys", ...o }));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEnv = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === "string");
const config = (r: Row): KeyConfig => ({ env: JSON.parse(r.env), settings: JSON.parse(r.settings) });

/** Кадр смены каждой машине: машина вне связи обновит ключ после подключения, поэтому сбой — только строка журнала. */
async function announce(env: Env, name: string): Promise<void> {
  await within(env.RELAY.broadcast({ type: "fleetkeys.changed", v: 1, from: ME, name }), "relay не ответил").catch((e) => line({ kind: "refuse", ev: "fleetkeys.changed", word: "offline", name, why: `relay.broadcast: ${e}` }));
}

async function frame(f: Frame, env: Env): Promise<Frame[]> {
  const { type, id, from, name } = f;
  const refuse = (word: string, why: string) => {
    line({ kind: "refuse", ev: type, word, why, from });
    return id ? [{ ...fail(id, word), to: from }] : [];
  };
  const off = accepts(f, CONTRACT);
  if (off) return refuse(off.word, off.why);
  if (!id) return refuse("bad_frame", `${type} без id — ответить некому`);
  if (type === "fleetkeys.list") {
    const { results } = await env.DB.prepare("SELECT name, env, settings FROM keys").all<Row>();
    return [{ ...ok(id, { keys: Object.fromEntries(results.map((r) => [r.name, config(r)])) }), to: from }];
  }
  if (typeof name !== "string" || !KEY_NAME.test(name)) return refuse("bad_frame", `имя ключа ${JSON.stringify(name)}: только латиница, цифры, _ и -`);
  const row = () => env.DB.prepare("SELECT name, env, settings, key FROM keys WHERE name = ?").bind(name).first<Row>();

  if (type === "fleetkeys.key") {
    if (kindOf(from) !== "machine") return refuse("not_machine", `${from} — не машина`);
    const r = await row();
    return r ? [{ ...ok(id, { ...config(r), key: r.key }), to: from }] : refuse("no_key", `ключа ${name} нет`);
  }

  if (type === "fleetkeys.remove") {
    const { meta } = await env.DB.prepare("DELETE FROM keys WHERE name = ?").bind(name).run();
    if (!meta.changes) return refuse("no_key", `ключа ${name} нет`);
    line({ ev: type, name, by: from });
    await announce(env, name);
    return [{ ...ok(id), to: from }];
  }
  const { env: vars, settings, value } = f;
  if (!isEnv(vars)) return refuse("bad_frame", `${name}: env — объект строк`);
  if (settings !== undefined && !isObject(settings)) return refuse("bad_frame", `${name}: settings — объект настроек Claude`);
  if (value !== undefined && (typeof value !== "string" || !value)) return refuse("bad_frame", `${name}: value — непустая строка`);
  const secret = value ?? (await row())?.key;
  if (!secret) return refuse("bad_frame", `${name}: новому ключу нужно значение value`);
  await env.DB.prepare("INSERT OR REPLACE INTO keys (name, env, settings, key) VALUES (?, ?, ?, ?)").bind(name, JSON.stringify(vars), JSON.stringify(settings ?? {}), secret).run();
  line({ ev: type, name, by: from });
  await announce(env, name);
  return [{ ...ok(id), to: from }];
}

export default {
  fetch: (req, env) => entrance(req, env.GATE, (f) => frame(f, env)),
} satisfies ExportedHandler<Env>;
