// Таблица passes базы D1: по функции на инструкцию. Секретов в базе нет, только sha256; адрес вычисляет сама база.
import type { Pass } from "../contract.ts";
import type { Role } from "./format.ts";

export type Env = { DB: D1Database };

const PUBLIC = "id, role, name, person, addr, state, by, at";

export const findPass = (db: D1Database, kid: string) =>
  db.prepare("SELECT role, name, state, hash, addr FROM passes WHERE id = ?").bind(kid).first<{ role: string; name: string; state: string; hash: string; addr: string }>();

/** Строка «ждёт приёма»; номер занят — null. Адрес занят живым пропуском — исключение UNIQUE. */
export async function addWaiting(db: D1Database, row: { kid: string; role: Role; name: string; person: string | null; hash: string; by: string }): Promise<string | null> {
  const added = await db
    .prepare("INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES (?, ?, ?, ?, 'wait', ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING addr")
    .bind(row.kid, row.role, row.name, row.person, row.hash, row.by, Date.now())
    .first<{ addr: string }>();
  return added?.addr ?? null;
}

/** Одна инструкция: приём сработает один раз. Приглашения нет, оно принято или отозвано — null. */
export const accept = (db: D1Database, kid: string, inviteHash: string, passHash: string) =>
  db.prepare("UPDATE passes SET state = 'ok', hash = ?, at = ? WHERE id = ? AND state = 'wait' AND hash = ? RETURNING role, name").bind(passHash, Date.now(), kid, inviteHash).first<{ role: string; name: string }>();

export async function listPasses(db: D1Database, role?: Role): Promise<Pass[]> {
  const q = role ? db.prepare(`SELECT ${PUBLIC} FROM passes WHERE role = ? AND state = 'ok' ORDER BY at`).bind(role) : db.prepare(`SELECT ${PUBLIC} FROM passes ORDER BY at`);
  return (await q.all<Pass>()).results;
}

export const deletePass = (db: D1Database, kid: string) => db.prepare("DELETE FROM passes WHERE id = ? RETURNING addr").bind(kid).first<{ addr: string }>();

export async function liveKids(db: D1Database, kids: string[]): Promise<Set<string>> {
  const found = await db.prepare(`SELECT id FROM passes WHERE id IN (${kids.map(() => "?").join(",")})`).bind(...kids).all<{ id: string }>();
  return new Set(found.results.map((r) => r.id));
}
