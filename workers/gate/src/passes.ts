// Правила пропусков над базой: на операцию одна команда SQL, гонки решает база. Исключение базы — «gate не ответил», его ловит дверь.
import type { Pass, Verified, VerifyResult } from "../contract.ts";
import { INVITE, PASS, fieldsWrong, newKid, newSecret, sha256 } from "./format.ts";

const KID_TRIES = 3;

export async function verify(db: D1Database, key: unknown): Promise<VerifyResult> {
  const m = typeof key === "string" ? PASS.exec(key) : null;
  if (!m) {
    console.log("bad_key пропуск не того вида: нужно role.name.kid.secret, роль host или client");
    return { error: "bad_key" };
  }
  const [, role, name, kid, secret] = m;
  const who = `${role}.${name}.${kid}`;
  const from = Date.now();
  const row = await db.prepare("SELECT role, name, state, hash, addr FROM passes WHERE id = ?").bind(kid).first<{ role: Verified["role"]; name: string; state: Pass["state"]; hash: string; addr: string }>();
  const ms = Date.now() - from;
  const denied = (why: string): VerifyResult => {
    console.log(`bad_key ${who} · ${why} · ${ms} мс`);
    return { error: "bad_key" };
  };
  if (!row) return denied("номера нет в базе");
  if (row.state !== "ok") return denied("пропуск не принят");
  if (row.role !== role || row.name !== name || row.hash !== (await sha256(secret))) return denied("не сошлись секрет, роль или имя");
  console.log(`ok ${who} → ${row.addr} · ${ms} мс`);
  return { role: row.role, name, kid, addr: row.addr };
}

/** Новая строка «ждёт приёма». Отказ — слово и причина; номер занят три раза подряд — исключение: база не даёт работать. */
export async function invite(db: D1Database, by: string, f: Record<string, unknown>): Promise<{ kid: string; invite: string; addr: string } | { error: "bad_request" | "name_taken"; why: string }> {
  const why = fieldsWrong(f.role, f.name, f.person);
  if (why) return { error: "bad_request", why };
  const code = newSecret();
  const hash = await sha256(code);
  const insert = db.prepare("INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES (?, ?, ?, ?, 'wait', ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING addr");
  for (let i = 0; i < KID_TRIES; i++) {
    const kid = newKid();
    try {
      const row = await insert.bind(kid, f.role, f.name, f.person ?? null, hash, by, Date.now()).first<{ addr: string }>();
      if (!row) continue;
      console.log(`invite ${kid} ${row.addr} · выдал ${by}`);
      return { kid, invite: `${kid}.${code}`, addr: row.addr };
    } catch (e) {
      // конфликт номера выше молчит: UNIQUE здесь может быть только про адрес, адрес знает база
      if (!String(e).includes("UNIQUE")) throw e;
      const taken = await db.prepare("SELECT addr FROM passes WHERE role = ? AND name = ? AND person IS ?").bind(f.role, f.name, f.person ?? null).first<{ addr: string }>();
      return { error: "name_taken", why: `у адреса ${taken?.addr} есть живой пропуск` };
    }
  }
  throw new Error("три номера подряд заняты");
}

/** Приглашение → пропуск; секрет пропуска рождается здесь и уходит один раз. Нет приглашения — null. */
export async function redeem(db: D1Database, invitation: unknown): Promise<string | null> {
  const m = typeof invitation === "string" ? INVITE.exec(invitation) : null;
  if (!m) {
    console.log("bad_invite приглашение не того вида: номер.секрет");
    return null;
  }
  const [, kid, code] = m;
  const secret = newSecret();
  const row = await db
    .prepare("UPDATE passes SET state = 'ok', hash = ?, at = ? WHERE id = ? AND state = 'wait' AND hash = ? RETURNING role, name")
    .bind(await sha256(secret), Date.now(), kid, await sha256(code))
    .first<{ role: string; name: string }>();
  if (!row) {
    console.log(`bad_invite приглашения ${kid} нет, оно принято или отозвано`);
    return null;
  }
  console.log(`redeem ${row.role}.${row.name}.${kid} · принят`);
  return `${row.role}.${row.name}.${kid}.${secret}`;
}

export async function revoke(db: D1Database, kid: string): Promise<{ addr: string } | { error: "unknown_key" }> {
  const row = await db.prepare("DELETE FROM passes WHERE id = ? RETURNING addr").bind(kid).first<{ addr: string }>();
  if (!row) {
    console.log(`unknown_key ${kid} · отзыв`);
    return { error: "unknown_key" };
  }
  console.log(`revoked ${kid} ${row.addr} · строка удалена`);
  return { addr: row.addr };
}

/** Какие из номеров отозваны; номер — kid или role.name.kid. Список — одним параметром: число номеров не упирается в предел переменных. */
export async function revoked(db: D1Database, ids: string[]): Promise<string[]> {
  const kidOf = (id: string) => id.split(".").at(-1)!;
  const { results } = await db.prepare("SELECT id FROM passes WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids.map(kidOf))).all<{ id: string }>();
  const live = new Set(results.map((r) => r.id));
  return ids.filter((id) => !live.has(kidOf(id)));
}

export async function list(db: D1Database, role?: Pass["role"]): Promise<Pass[]> {
  const columns = "SELECT id, role, name, person, addr, state, by, at FROM passes";
  const q = role ? db.prepare(`${columns} WHERE role = ? AND state = 'ok' ORDER BY at`).bind(role) : db.prepare(`${columns} ORDER BY at`);
  return (await q.all<Pass>()).results;
}
