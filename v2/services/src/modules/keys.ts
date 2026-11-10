// Ключи флота: ключи API для сессий без входа Claude. Значение получает только машина.
import { Refusal } from "@sb/protocol";
import type { Ctx, Env, Module } from "../env.ts";
import { records } from "../records.ts";

const NAME = "keys";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS keys (name TEXT PRIMARY KEY, provider TEXT, value TEXT, base TEXT, model TEXT, at INTEGER)",
  // дополнения ключа: соответствие моделей, окно контекста, настройки и окружение сессии — одним объектом
  "CREATE TABLE IF NOT EXISTS keyopts (name TEXT PRIMARY KEY, opts TEXT NOT NULL)",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

type Opts = { models?: Record<string, string>; window?: number; settings?: Record<string, unknown>; env?: Record<string, string> };
type Stored = { name: string; provider: string; value: string; base: string | null; model: string | null; at: number; opts: string | null };
type Input = { name: string; provider: string; value?: string; base?: string; model?: string } & Opts;

const OPTS = ["models", "window", "settings", "env"] as const;
const SELECT = "SELECT keys.*, keyopts.opts AS opts FROM keys LEFT JOIN keyopts ON keyopts.name = keys.name";
const extras = (s: Stored) => ({ ...(s.base ? { base: s.base } : {}), ...(s.model ? { model: s.model } : {}), ...(s.opts ? (JSON.parse(s.opts) as Opts) : {}) });
const told = (ctx: Ctx) => ctx.platform.broadcast(ctx.fleet, { type: "changed", what: "keys", trace: ctx.trace }, "host");

/** Сессии флота, которые сейчас идут на ключе: по документу сессии и по выбранному аккаунту. */
async function sessionsOn(ctx: Ctx): Promise<Map<string, string[]>> {
  const by = new Map<string, string[]>();
  for (const s of await ctx.platform.sessions(ctx.fleet)) {
    const name = s.account ?? s.spec?.account;
    if (name) (by.get(name) ?? by.set(name, []).get(name)!).push(s.callsign);
  }
  return by;
}

export const keys: Module = {
  name: NAME,
  handlers: {
    async "keys.list"(_i, ctx) {
      const [rows, on] = await Promise.all([db(ctx.env, ctx.fleet).all<Stored>(`${SELECT} ORDER BY keys.name`), sessionsOn(ctx)]);
      return { keys: rows.map((s) => ({ name: s.name, provider: s.provider, at: s.at, tail: s.value.slice(-4), ...extras(s), sessions: on.get(s.name)?.length ?? 0 })) };
    },

    async "keys.set"(i: Input, ctx) {
      const d = db(ctx.env, ctx.fleet);
      const was = await d.first<Stored>(`${SELECT} WHERE keys.name = ?`, i.name);
      // без значения правятся свойства уже записанного ключа
      if (i.value === undefined && !was) throw new Refusal("not_found", `ключа ${i.name} нет: первому сохранению нужно значение`);
      const opts: Opts = { ...(was?.opts ? (JSON.parse(was.opts) as Opts) : {}) };
      for (const k of OPTS) if (i[k] !== undefined) (opts as Record<string, unknown>)[k] = i[k];
      await d.batch([
        ["INSERT OR REPLACE INTO keys (name, provider, value, base, model, at) VALUES (?, ?, ?, ?, ?, ?)", i.name, i.provider, i.value ?? was!.value, i.base ?? null, i.model ?? null, Date.now()],
        Object.keys(opts).length ? ["INSERT OR REPLACE INTO keyopts (name, opts) VALUES (?, ?)", i.name, JSON.stringify(opts)] : ["DELETE FROM keyopts WHERE name = ?", i.name],
      ]);
      await told(ctx);
      return {};
    },

    async "keys.remove"(i: { name: string; probe?: boolean }, ctx) {
      // проба: ничего не удаляет — человек видит, какие сессии останутся без ключа
      if (i.probe) return { sessions: (await sessionsOn(ctx)).get(i.name) ?? [] };
      await db(ctx.env, ctx.fleet).batch([
        ["DELETE FROM keys WHERE name = ?", i.name],
        ["DELETE FROM keyopts WHERE name = ?", i.name],
      ]);
      await told(ctx);
      return {};
    },

    async "keys.value"(i: { name: string }, ctx) {
      const s = await db(ctx.env, ctx.fleet).first<Stored>(`${SELECT} WHERE keys.name = ?`, i.name);
      if (!s) throw new Refusal("not_found", `ключа ${i.name} нет`);
      return { value: s.value, provider: s.provider, ...extras(s) };
    },
  },
};
