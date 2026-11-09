// Ключи флота: ключи API для сессий без входа Claude. Значение получает только машина.
import { Refusal } from "@sb/protocol";
import type { Ctx, Env, Module } from "../env.ts";
import { records } from "../records.ts";

const NAME = "keys";
const SCHEMA = ["CREATE TABLE IF NOT EXISTS keys (name TEXT PRIMARY KEY, provider TEXT, value TEXT, base TEXT, model TEXT, at INTEGER)"];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

type Stored = { name: string; provider: string; value: string; base: string | null; model: string | null; at: number };
const extras = (s: Stored) => ({ ...(s.base ? { base: s.base } : {}), ...(s.model ? { model: s.model } : {}) });
const told = (ctx: Ctx) => ctx.platform.broadcast(ctx.fleet, { type: "changed", what: "keys", trace: ctx.trace }, "host");

export const keys: Module = {
  name: NAME,
  handlers: {
    async "keys.list"(_i, ctx) {
      const rows = await db(ctx.env, ctx.fleet).all<Stored>("SELECT * FROM keys ORDER BY name");
      return { keys: rows.map((s) => ({ name: s.name, provider: s.provider, at: s.at, tail: s.value.slice(-4), ...extras(s) })) };
    },
    async "keys.set"(i: { name: string; provider: string; value: string; base?: string; model?: string }, ctx) {
      await db(ctx.env, ctx.fleet).run(
        "INSERT OR REPLACE INTO keys (name, provider, value, base, model, at) VALUES (?, ?, ?, ?, ?, ?)",
        i.name, i.provider, i.value, i.base ?? null, i.model ?? null, Date.now(),
      );
      await told(ctx);
      return {};
    },
    async "keys.remove"(i: { name: string }, ctx) {
      await db(ctx.env, ctx.fleet).run("DELETE FROM keys WHERE name = ?", i.name);
      await told(ctx);
      return {};
    },
    async "keys.value"(i: { name: string }, ctx) {
      const s = await db(ctx.env, ctx.fleet).first<Stored>("SELECT * FROM keys WHERE name = ?", i.name);
      if (!s) throw new Refusal("not_found", `ключа ${i.name} нет`);
      return { value: s.value, provider: s.provider, ...extras(s) };
    },
  },
};
