// Строка приложения в базе D1 модуля. Ключ pem — только здесь: в ответы, кадры и журнал не попадает.
export type AppRow = { id: number; slug: string; owner: string; pem: string; at: number; by: string };

export const readApp = (db: D1Database): Promise<AppRow | null> => db.prepare("SELECT id, slug, owner, pem, at, by FROM app WHERE one = 1").first<AppRow>();

export async function saveApp(db: D1Database, a: AppRow): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO app (one, id, slug, owner, pem, at, by) VALUES (1, ?, ?, ?, ?, ?, ?)").bind(a.id, a.slug, a.owner, a.pem, a.at, a.by).run();
}
