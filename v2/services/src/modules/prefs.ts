// Настройки: свои (область me) и общие записи флота (область fleet). Запись в общие — машины получают кадр «изменилось».
import { Refusal } from "@sb/protocol";
import type { Ctx, Env, Module } from "../env.ts";
import { records } from "../records.ts";

const NAME = "prefs";
const SCHEMA = ["CREATE TABLE IF NOT EXISTS prefs (scope TEXT, name TEXT, value TEXT, PRIMARY KEY (scope, name))"];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

/** Область записи: общая или человека. */
const scopeOf = (scope: "me" | "fleet", ctx: Ctx) => (scope === "fleet" ? "fleet" : ctx.who.person);

export const prefs: Module = {
  name: NAME,
  handlers: {
    async "prefs.get"(i: { scope: "me" | "fleet"; prefix?: string }, ctx) {
      const p = i.prefix ?? "";
      const rows = await db(ctx.env, ctx.fleet).all<{ name: string; value: string }>(
        "SELECT name, value FROM prefs WHERE scope = ? AND substr(name, 1, length(?)) = ?",
        scopeOf(i.scope, ctx), p, p,
      );
      return { values: Object.fromEntries(rows.map((r) => [r.name, JSON.parse(r.value)])) };
    },

    async "prefs.set"(i: { scope: "me" | "fleet"; name: string; value?: unknown; patch?: Record<string, unknown> }, ctx) {
      if ((i.value === undefined) === (i.patch === undefined)) throw new Refusal("bad_input", "нужно одно из двух: value или patch");
      // правила прокси меняют запросы всех сессий к моделям: только админ
      if (i.scope === "fleet" && i.name.startsWith("proxy.") && !ctx.who.admin) throw new Refusal("forbidden", "правила прокси меняет админ флота");
      const scope = scopeOf(i.scope, ctx);
      const d = db(ctx.env, ctx.fleet);
      if (i.patch) {
        // заплатка одним запросом записей: ключ со значением null убирается (RFC 7396)
        await d.run(
          "INSERT INTO prefs (scope, name, value) VALUES (?1, ?2, json_patch('{}', ?3)) ON CONFLICT (scope, name) DO UPDATE SET value = json_patch(prefs.value, ?3)",
          scope, i.name, JSON.stringify(i.patch),
        );
      } else if (i.value === null) await d.run("DELETE FROM prefs WHERE scope = ? AND name = ?", scope, i.name);
      else await d.run("INSERT OR REPLACE INTO prefs (scope, name, value) VALUES (?, ?, ?)", scope, i.name, JSON.stringify(i.value));
      if (i.scope === "fleet") await ctx.platform.broadcast(ctx.fleet, { type: "changed", what: i.name, trace: ctx.trace }, "host");
      return {};
    },
  },
};
