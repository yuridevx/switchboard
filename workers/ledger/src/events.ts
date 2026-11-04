// Таблица events базы D1: строка на запись, номер — курсор чтения.
import type { LedgerEvent, LedgerReadResult } from "../contract.ts";
import { LEFT, BACK } from "./presence.ts";

type Row = { id: number; t: number; ev: string; from: string; by: string | null; machine: string | null; callsign: string | null; text: string };
type New = { ev: string; from: string; text: string; by?: string | null; machine?: string | null; callsign?: string | null };

export async function append(db: D1Database, e: New): Promise<void> {
  await db
    .prepare('INSERT INTO events (t, ev, "from", by, machine, callsign, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(Date.now(), e.ev, e.from, e.by ?? null, e.machine ?? null, e.callsign ?? null, e.text)
    .run();
}

/** Последняя запись о входе или уходе машины. */
export function lastPresence(db: D1Database, machine: string) {
  return db.prepare("SELECT ev, t FROM events WHERE machine = ? AND ev IN (?, ?) ORDER BY id DESC LIMIT 1").bind(machine, LEFT, BACK).first<{ ev: string; t: number }>();
}

/** Страница записей: after — ближайшие более новые, иначе ближайшие более старые; в ответе всегда новые сначала. */
export async function page(db: D1Database, q: { limit: number; after?: number; before?: number; machine?: string }): Promise<LedgerReadResult> {
  const forward = q.after !== undefined;
  const cursor = forward ? { sql: "id > ?", arg: q.after } : q.before !== undefined ? { sql: "id < ?", arg: q.before } : null;
  const filters = [...(q.machine !== undefined ? [{ sql: "machine = ?", arg: q.machine }] : []), ...(cursor ? [cursor] : [])];
  const where = filters.length ? `WHERE ${filters.map((x) => x.sql).join(" AND ")}` : "";
  const { results } = await db
    .prepare(`SELECT * FROM events ${where} ORDER BY id ${forward ? "ASC" : "DESC"} LIMIT ?`)
    .bind(...filters.map((x) => x.arg), q.limit + 1)
    .all<Row>();
  const rows = results.slice(0, q.limit);
  if (forward) rows.reverse();
  return { events: rows.map(toEvent), more: results.length > q.limit };
}

/** Строка таблицы → запись контракта: пустых полей в записи нет. */
function toEvent({ by, machine, callsign, ...r }: Row): LedgerEvent {
  return { ...r, ...(by !== null ? { by } : {}), ...(machine !== null ? { machine } : {}), ...(callsign !== null ? { callsign } : {}) };
}
