// Пропуск стенда для тестов relay: строка в базе gate стенда и сам пропуск role.name.kid.секрет — без workerd,
// его зовут и тесты в узле. Секрет пропуска — от строки secret: другая строка даёт пропуск, у которого не сходится хэш.
import { sha256 } from "../../gate/src/key.ts";

/** Строка, от которой стенд выводит верный секрет пропуска. */
export const SECRET = "test-secret";
/** Номер, отозванный на стенде. */
export const REVOKED_KID = "k2a9";
/** Человек за устройствами стенда: адрес клиента — имя~OWNER. */
export const OWNER = "owner@example.com";

type Db = { prepare(q: string): { bind(...a: unknown[]): { run(): Promise<unknown> } } };

const code = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Положить строку пропуска (номер kid, верный секрет; k2a9 — отозван: строки нет) и отдать пропуск с секретом от secret. */
export async function standPass(db: Db, role: "host" | "client", name: string, kid: string, secret = SECRET): Promise<string> {
  if (kid === REVOKED_KID) {
    await db.prepare("DELETE FROM passes WHERE id = ?").bind(kid).run();
    return `${role}.${name}.${kid}.${code(secret)}`;
  }
  await db
    .prepare("INSERT OR REPLACE INTO passes (id, role, name, person, state, hash, by, at) VALUES (?, ?, ?, ?, ?, ?, 'test', ?)")
    .bind(kid, role, name, role === "client" ? OWNER : null, "ok", await sha256(code(SECRET)), Date.now())
    .run();
  return `${role}.${name}.${kid}.${code(secret)}`;
}
