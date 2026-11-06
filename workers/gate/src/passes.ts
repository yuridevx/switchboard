// Операции над таблицей пропусков: одна операция — один оператор SQL, атомарность и адрес — у базы.
// Отказ — значение со словом и строка журнала; исключение значит «база не ответила».
import type { Pass, VerifyResult } from "../contract.ts";
import { fieldsWrong, INVITE, newKid, newSecret, PASS, sha256 } from "./format.ts";

const KID_TRIES = 3;
const BAD_INVITE = { error: "bad_invite" } as const;

export async function verify(db: D1Database, key: unknown): Promise<VerifyResult> {
  const from = Date.now();
  const m = typeof key === "string" ? PASS.exec(key) : null;
  if (!m) {
    console.log("bad_key пропуск не того вида: нужно role.name.kid.secret, роль host или client");
    return { error: "bad_key" };
  }
  const [, role, name, kid, secret] = m;
  const row = await db.prepare("SELECT role, name, state, hash, addr FROM passes WHERE id = ?").bind(kid).first<Pass & { hash: string }>();
  const pass = `${role}.${name}.${kid}`;
  const said = (line: string) => console.log(`${line} · ${Date.now() - from} мс`);
  const refused = (why: string) => {
    said(`bad_key ${pass} · ${why}`);
    return { error: "bad_key" } as const;
  };
  if (!row) return refused("номера нет в базе");
  if (row.state !== "ok") return refused("пропуск не принят");
  if (row.hash !== (await sha256(secret)) || `${row.role}.${row.name}` !== `${role}.${name}`) return refused("не сошлись секрет, роль или имя");
  said(`ok ${pass} → ${row.addr}`);
  return { role: row.role, name, kid, addr: row.addr };
}

/** Приглашение: строка «ждёт приёма» с хэшем секрета. Занят адрес — name_taken, занят номер — следующий номер. */
export async function invite(db: D1Database, f: Record<string, unknown>, by: string) {
  const why = fieldsWrong(f);
  if (why) {
    console.log(`bad_request keys.invite от ${by} · ${why}`);
    return { error: "bad_request" };
  }
  const person = f.person ?? null;
  const secret = newSecret();
  const hash = await sha256(secret);
  for (let i = 0; i < KID_TRIES; i++) {
    const kid = newKid();
    const row = await db
      .prepare("INSERT OR IGNORE INTO passes (id, role, name, person, state, hash, by, at) VALUES (?, ?, ?, ?, 'wait', ?, ?, ?) RETURNING addr")
      .bind(kid, f.role, f.name, person, hash, by, Date.now())
      .first<{ addr: string }>();
    if (row) {
      console.log(`invite ${kid} ${row.addr} · выдал ${by}`);
      return { kid, invite: `${kid}.${secret}`, addr: row.addr };
    }
    const taken = await db.prepare("SELECT addr FROM passes WHERE role = ? AND name = ? AND person IS ?").bind(f.role, f.name, person).first<{ addr: string }>();
    if (taken) {
      console.log(`name_taken keys.invite от ${by} · у адреса ${taken.addr} есть живой пропуск`);
      return { error: "name_taken" };
    }
  }
  throw new Error("три номера подряд заняты");
}

/** Приём: секрет приглашения меняется на секрет пропуска одним оператором, второй приём строки не найдёт. */
export async function redeem(db: D1Database, code: unknown) {
  const m = typeof code === "string" ? INVITE.exec(code) : null;
  if (!m) {
    console.log("bad_invite приглашение не того вида: номер.секрет");
    return BAD_INVITE;
  }
  const [, kid, old] = m;
  const secret = newSecret();
  const row = await db
    .prepare("UPDATE passes SET state = 'ok', hash = ?, at = ? WHERE id = ? AND state = 'wait' AND hash = ? RETURNING role, name")
    .bind(await sha256(secret), Date.now(), kid, await sha256(old))
    .first<{ role: string; name: string }>();
  if (!row) {
    console.log(`bad_invite приглашения ${kid} нет, оно принято или отозвано`);
    return BAD_INVITE;
  }
  console.log(`redeem ${row.role}.${row.name}.${kid} · принят`);
  return { key: `${row.role}.${row.name}.${kid}.${secret}` };
}

export async function revoke(db: D1Database, kid: string) {
  const row = await db.prepare("DELETE FROM passes WHERE id = ? RETURNING addr").bind(kid).first<{ addr: string }>();
  if (!row) {
    console.log(`unknown_key ${kid} · отзыв`);
    return { error: "unknown_key" } as const;
  }
  console.log(`revoked ${kid} ${row.addr} · строка удалена`);
  return row;
}

const kidOf = (id: string) => id.split(".").at(-1)!;

/** Какие номера отозваны. Список идёт одной переменной: у базы предел числа переменных. */
export async function revoked(db: D1Database, ids: string[]) {
  const { results } = await db.prepare("SELECT id FROM passes WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids.map(kidOf))).all<{ id: string }>();
  const live = new Set(results.map((r) => r.id));
  return ids.filter((id) => !live.has(kidOf(id)));
}

export async function list(db: D1Database, role?: Pass["role"]) {
  const columns = "SELECT id, role, name, person, addr, state, by, at FROM passes";
  const query = role ? db.prepare(`${columns} WHERE role = ? AND state = 'ok' ORDER BY at`).bind(role) : db.prepare(`${columns} ORDER BY at`);
  return (await query.all<Pass>()).results;
}
