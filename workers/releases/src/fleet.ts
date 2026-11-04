// Строка флота в базе D1 модуля: stable частей, отличия планов машин и одна rev. Правка — только поверх прочитанной: вторая одновременная не находит строку — conflict.
import type { PlanEntry } from "../contract.ts";
import type { Env } from "./env.ts";
import { Refusal } from "./refusal.ts";

export type Plans = Record<string, Record<string, PlanEntry>>;
export type Fleet = { stable: Record<string, string>; plans: Plans; rev: number };

export async function readFleet(env: Env): Promise<Fleet> {
  const row = await env.DB.prepare("SELECT stable, plans, rev FROM fleet WHERE one = 1").first<{ stable: string; plans: string; rev: number }>();
  if (!row) throw new Error("в базе «Выпусков» нет строки флота — миграция не применена");
  return { stable: JSON.parse(row.stable), plans: JSON.parse(row.plans), rev: row.rev };
}

/** Записать поверх read: ответ — строка с новой rev. */
export async function writeFleet(env: Env, read: Fleet, change: Partial<Pick<Fleet, "stable" | "plans">>): Promise<Fleet> {
  const next: Fleet = { stable: change.stable ?? read.stable, plans: change.plans ?? read.plans, rev: read.rev + 1 };
  const r = await env.DB.prepare("UPDATE fleet SET stable = ?, plans = ?, rev = ? WHERE one = 1 AND rev = ?").bind(JSON.stringify(next.stable), JSON.stringify(next.plans), next.rev, read.rev).run();
  if (!r.meta.changes) throw new Refusal("conflict", `строку флота уже правили после rev ${read.rev} — повтори запрос`);
  return next;
}
