// Настройки пользователя над базой D1 модуля: одна таблица prefs. Пользователь — только из адреса отправителя.
import { accepts, fail, ok, userOf, type Frame } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

/** Кадр с to: ".prefs" → ответ отправителю. */
export async function frame(env: Env, f: Frame): Promise<Frame[]> {
  const from = f.from ?? "";
  const refuse = (word: string, why: string): Frame[] => {
    log({ kind: "refuse", ev: f.type, word, why, from });
    return f.id ? [{ ...fail(f.id, word), to: from }] : [];
  };

  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", from, why: "prefs ответов не ждёт" });
    return [];
  }
  const bad = accepts(f, CONTRACT);
  if (bad) return refuse(bad.word, bad.why);
  if (!f.id) return refuse("bad_frame", `${f.type} без id — ответить некому`);
  const user = userOf(from);
  if (!user) return refuse("not_user", `${from} — не человек и не его устройство`);

  if (f.type === "prefs.get") {
    const rows = (await env.DB.prepare("SELECT key, value FROM prefs WHERE user = ?").bind(user).all<{ key: string; value: string }>()).results;
    return [{ ...ok(f.id, { values: Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) }), to: from }];
  }

  // prefs.set
  if (typeof f.name !== "string" || !f.name) return refuse("bad_frame", "в prefs.set нет name");
  if (f.value === undefined) return refuse("bad_frame", `в prefs.set ${f.name} нет value`);
  await env.DB.prepare("INSERT INTO prefs (user, key, value) VALUES (?, ?, ?) ON CONFLICT (user, key) DO UPDATE SET value = excluded.value").bind(user, f.name, JSON.stringify(f.value)).run();
  return [{ ...ok(f.id), to: from }];
}
