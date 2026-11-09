// Операции над таблицей пропусков: одна операция — один оператор SQL, атомарность и адрес — у базы.
// Отказ — значение со словом и строка журнала; исключение значит «база не ответила».
import { kindOf, READ_MS, within } from "@switchboard/protocol";
import type { ListFilter, Pass, Redeemed, VerifyResult } from "../contract.ts";
import { fieldsWrong, INVITE, KINDS, labelOf, newKid, newSecret, PASS, s256, sha256 } from "./format.ts";

const KID_TRIES = 3;
const BAD_INVITE = { error: "bad_invite" } as const;
/** Приглашение живёт сутки: ссылка из истории чата во флот не входит. */
export const INVITE_MS = 24 * 3600_000;

export async function verify(db: D1Database, key: unknown): Promise<VerifyResult> {
  const from = Date.now();
  const m = typeof key === "string" ? PASS.exec(key) : null;
  if (!m) {
    console.log("bad_key пропуск не того вида: нужно подпись.номер.секрет");
    return { error: "bad_key" };
  }
  const [, label, kid, secret] = m;
  const row = await db.prepare("SELECT state, hash, addr FROM passes WHERE id = ?").bind(kid).first<{ state: string; hash: string; addr: string }>();
  const pass = `${label}.${kid}`;
  const said = (line: string) => console.log(`${line} · ${Date.now() - from} мс`);
  const refused = (why: string) => {
    said(`bad_key ${pass} · ${why}`);
    return { error: "bad_key" } as const;
  };
  if (!row) return refused("номера нет в базе");
  if (row.state !== "ok") return refused("пропуск не принят");
  if (row.hash !== (await sha256(secret))) return refused("секрет не тот");
  said(`ok ${pass} → ${row.addr}`);
  return { kid, addr: row.addr };
}

/** Адрес возврата клиента OAuth есть в его описании по адресу client. Loopback — с любым портом (RFC 8252). */
async function backOk(client: string, back: string): Promise<string | null> {
  let doc: { client_id?: unknown; redirect_uris?: unknown };
  try {
    const res = await within(fetch(client, { headers: { accept: "application/json" } }), `описание клиента ${client} молчит`, READ_MS);
    if (!res.ok) return `описание клиента ${client}: ${res.status}`;
    doc = await res.json();
  } catch (e) {
    return `описание клиента ${client}: ${(e as Error).message}`;
  }
  if (doc.client_id !== client) return `описание клиента ${client}: client_id ${JSON.stringify(doc.client_id)}`;
  const want = new URL(back);
  const loop = (u: URL) => ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  const same = (u: string) => {
    try {
      const x = new URL(u);
      return loop(x) && loop(want) ? x.protocol === want.protocol && x.hostname === want.hostname && x.pathname === want.pathname : x.href === want.href;
    } catch {
      return false;
    }
  };
  return Array.isArray(doc.redirect_uris) && doc.redirect_uris.some((u) => typeof u === "string" && same(u)) ? null : `${back} нет в redirect_uris клиента ${client}`;
}

/** Приглашение: строка «ждёт приёма» с хэшем секрета. Занят адрес — name_taken, занят номер — следующий номер; просроченное приглашение адреса уходит. */
export async function invite(db: D1Database, f: Record<string, unknown>, by: string) {
  const refuse = (word: string, why: string) => {
    console.log(`${word} keys.invite от ${by} · ${why}`);
    return { error: word };
  };
  const why = fieldsWrong(f);
  if (why) return refuse("bad_request", why);
  const addr = f.addr as string;
  const oauth = f.challenge !== undefined ? ([f.challenge, f.client, f.back] as string[]) : null;
  if (oauth) {
    const bad = await backOk(oauth[1], oauth[2]);
    if (bad) return refuse("bad_client", bad);
  }
  const now = Date.now();
  await db.prepare("DELETE FROM passes WHERE addr = ? AND state = 'wait' AND at < ?").bind(addr, now - INVITE_MS).run();
  const secret = newSecret();
  const hash = await sha256(secret);
  for (let i = 0; i < KID_TRIES; i++) {
    const kid = newKid();
    const row = await db
      .prepare("INSERT OR IGNORE INTO passes (id, addr, owner, state, hash, by, at, challenge, client, back) VALUES (?, ?, ?, 'wait', ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(kid, addr, f.owner ?? null, hash, by, now, ...(oauth ?? [null, null, null]))
      .first<{ id: string }>();
    if (row) {
      console.log(`invite ${kid} ${addr} · выдал ${by}${oauth ? ` · клиент ${oauth[1]}` : ""}`);
      return { kid, invite: `${kid}.${secret}`, addr };
    }
    const taken = await db.prepare("SELECT id FROM passes WHERE addr = ?").bind(addr).first();
    if (taken) return refuse("name_taken", `у адреса ${addr} есть живой пропуск`);
  }
  throw new Error("три номера подряд заняты");
}

/**
 * Приём: секрет приглашения меняется на секрет пропуска одним оператором, второй приём строки не найдёт.
 * Приглашение согласия OAuth принимается только с verifier PKCE, тем же клиентом и адресом возврата; простое — без них.
 */
export async function redeem(db: D1Database, code: unknown, oauth?: { verifier: string; client: string; back: string }): Promise<Redeemed | typeof BAD_INVITE> {
  const m = typeof code === "string" ? INVITE.exec(code) : null;
  if (!m) {
    console.log("bad_invite приглашение не того вида: номер.секрет");
    return BAD_INVITE;
  }
  const [, kid, old] = m;
  const secret = newSecret();
  const now = Date.now();
  const check = oauth ? "challenge = ? AND client = ? AND back = ?" : "challenge IS NULL";
  const row = await db
    .prepare(`UPDATE passes SET state = 'ok', hash = ?, at = ? WHERE id = ? AND state = 'wait' AND hash = ? AND at >= ? AND ${check} RETURNING addr`)
    .bind(await sha256(secret), now, kid, await sha256(old), now - INVITE_MS, ...(oauth ? [await s256(oauth.verifier), oauth.client, oauth.back] : []))
    .first<{ addr: string }>();
  if (!row) {
    console.log(`bad_invite приглашения ${kid} нет, оно принято, отозвано, старше суток${oauth ? " или PKCE, клиент и адрес возврата не сошлись" : " или ждёт PKCE"}`);
    return BAD_INVITE;
  }
  const label = labelOf(row.addr);
  console.log(`redeem ${label}.${kid} ${row.addr} · принят`);
  return { key: `${label}.${kid}.${secret}`, addr: row.addr, kid };
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

/** Что не так в фильтре keys.list или null. */
export function filterWrong(f: Record<string, unknown>): string | null {
  if (f.ids !== undefined && !(Array.isArray(f.ids) && f.ids.every((x) => typeof x === "string"))) return "ids — список номеров";
  if (f.kind !== undefined && !(KINDS as readonly string[]).includes(f.kind as string)) return "kind — machine, device или session";
  return null;
}

/** Пропуска по времени выдачи; ids — только эти номера (список одной переменной: у базы предел числа переменных), kind — форма адреса. */
export async function list(db: D1Database, o: ListFilter = {}): Promise<Pass[]> {
  const columns = "SELECT id AS kid, addr, owner, state FROM passes";
  const query = o.ids ? db.prepare(`${columns} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY at`).bind(JSON.stringify(o.ids)) : db.prepare(`${columns} ORDER BY at`);
  const { results } = await query.all<{ kid: string; addr: string; owner: string | null; state: string }>();
  return results.filter((r) => !o.kind || kindOf(r.addr) === o.kind).map(({ state, ...r }) => ({ ...r, wait: state === "wait" }));
}
