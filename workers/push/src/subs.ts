// Таблица подписок: строка на устройство. Только запросы к базе; кому пушить и зачем решает вызывающий.
import { kindOf, reaches } from "@switchboard/protocol";

export type Sub = { client: string; endpoint: string; p256dh: string; auth: string; at: number; kid: string | null };

/** Подписка устройства: новая заменяет прежнюю; номер пропуска — чтобы его отзыв гасил уведомления. */
export const save = (db: D1Database, s: Omit<Sub, "at">) =>
  db.prepare("INSERT OR REPLACE INTO subs (client, endpoint, p256dh, auth, at, kid) VALUES (?, ?, ?, ?, ?, ?)").bind(s.client, s.endpoint, s.p256dh, s.auth, Date.now(), s.kid).run();

/** Подписки адреса: устройства — его одна; человека — все его, кроме skip. */
export async function reach(db: D1Database, to: string, skip: string[]): Promise<Sub[]> {
  if (kindOf(to) !== "user") return (await db.prepare("SELECT * FROM subs WHERE client = ?").bind(to).all<Sub>()).results;
  const { results } = await db.prepare("SELECT * FROM subs").all<Sub>();
  return results.filter((s) => reaches(to, s.client) && !skip.includes(s.client));
}

/** Пропуск отозван: строку, подписанную им, — долой. */
export const dropByKid = (db: D1Database, client: string, kid: string) => db.prepare("DELETE FROM subs WHERE client = ? AND kid = ?").bind(client, kid).run();

/** Служба сказала, что подписки нет: строку, которую клиент успел заменить, не трогаем. */
export const dropByEndpoint = (db: D1Database, client: string, endpoint: string) => db.prepare("DELETE FROM subs WHERE client = ? AND endpoint = ?").bind(client, endpoint).run();
