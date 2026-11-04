// Пропуска над базой D1 gate: проверка, приглашение, приём, список, отзыв. Номера нет в базе — bad_key.
import type { Pass, Verified, VerifyResult } from "../contract.ts";
import { newKid, parseKey, secret, sha256 } from "./key.ts";

export type Env = { DB: D1Database };

type Log = (line: string) => void;

const PART = /^[A-Za-z0-9_-]+$/;
const PERSON = /^[^\s~@]+@[^\s~@]+$/;

/** Пропуск role.name.kid.секрет: строка базы по номеру — правда о роли и имени. */
export async function verify(env: Env, key: unknown, log: Log): Promise<VerifyResult> {
  const p = parseKey(key);
  if (!p) {
    log("bad_key пропуск не того вида: нужно role.name.kid.secret, роль host или client");
    return { error: "bad_key" };
  }
  const t = Date.now();
  const row = await env.DB.prepare("SELECT role, name, state, hash, addr FROM passes WHERE id = ?")
    .bind(p.kid)
    .first<{ role: string; name: string; state: string; hash: string; addr: string }>();
  const ms = Date.now() - t;
  if (!row) {
    log(`bad_key ${p.id} · номера нет в базе · ${ms} мс`);
    return { error: "bad_key" };
  }
  if (row.role !== p.role || row.name !== p.name || row.state === "wait" || (await sha256(p.sig)) !== row.hash) {
    log(`bad_key ${p.id} · ${row.state === "wait" ? "пропуск не принят" : "не сошлись секрет, роль или имя"} · ${ms} мс`);
    return { error: "bad_key" };
  }
  log(`ok ${p.id} → ${row.addr} · ${ms} мс`);
  return { role: p.role, name: p.name, kid: p.kid, addr: row.addr };
}

export type Word = { error: string; why: string };

/** keys.invite: строка «ждёт приёма» с хэшем приглашения. Адрес занят живым пропуском — name_taken. */
export async function invite(env: Env, by: Verified, f: Record<string, unknown>): Promise<{ kid: string; invite: string; addr: string } | Word> {
  const { role, name, person } = f;
  if (role !== "host" && role !== "client") return { error: "bad_request", why: "role — host или client" };
  if (typeof name !== "string" || !PART.test(name)) return { error: "bad_request", why: "name — A-Z a-z 0-9 _ -" };
  if (role === "client" && (typeof person !== "string" || !PERSON.test(person))) return { error: "bad_request", why: "person — почта человека за устройством или программой" };
  if (role === "host" && person !== undefined) return { error: "bad_request", why: "у машины person нет" };
  const code = secret();
  const hash = await sha256(code);
  // номер — 4 знака: совпадение с существующим — новый номер
  for (let i = 0; i < 3; i++) {
    const kid = newKid();
    try {
      const row = await env.DB.prepare("INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES (?, ?, ?, ?, 'wait', ?, ?, ?) RETURNING addr")
        .bind(kid, role, name, role === "client" ? person : null, hash, by.addr, Date.now())
        .first<{ addr: string }>();
      return { kid, invite: `${kid}.${code}`, addr: row!.addr };
    } catch (e) {
      const m = String((e as Error).message);
      if (m.includes("passes.id")) continue;
      if (m.includes("UNIQUE")) return { error: "name_taken", why: `у адреса ${role === "host" ? "@" + name : name + "~" + person} есть живой пропуск` };
      throw e;
    }
  }
  throw new Error("три номера подряд заняты");
}

/** gate.redeem: одна инструкция по строке «ждёт приёма» с хэшем приглашения; 0 строк — bad_invite. */
export async function redeem(env: Env, f: Record<string, unknown>): Promise<{ key: string } | Word> {
  const inv = f.invite;
  const m = typeof inv === "string" ? /^([a-z0-9]{4})\.([A-Za-z0-9_-]{43})$/.exec(inv) : null;
  if (!m) return { error: "bad_invite", why: "приглашение не того вида: номер.секрет" };
  const code = secret();
  const row = await env.DB.prepare("UPDATE passes SET state = 'ok', hash = ?, at = ? WHERE id = ? AND state = 'wait' AND hash = ? RETURNING role, name")
    .bind(await sha256(code), Date.now(), m[1], await sha256(m[2]))
    .first<{ role: string; name: string }>();
  if (!row) return { error: "bad_invite", why: `приглашения ${m[1]} нет, оно принято или отозвано` };
  return { key: `${row.role}.${row.name}.${m[1]}.${code}` };
}

/** keys.list: строки без хэша; с role — только принятые этой роли (машины флота). */
export async function list(env: Env, f: Record<string, unknown>): Promise<{ passes: Pass[] } | Word> {
  const role = f.role;
  if (role !== undefined && role !== "host" && role !== "client") return { error: "bad_request", why: "role — host или client" };
  const cols = "id, role, name, person, addr, state, by, at";
  const q = role
    ? env.DB.prepare(`SELECT ${cols} FROM passes WHERE role = ? AND state = 'ok' ORDER BY at`).bind(role)
    : env.DB.prepare(`SELECT ${cols} FROM passes ORDER BY at`);
  return { passes: (await q.all<Pass>()).results };
}

/** gate.revoke: строка удаляется; номера нет — unknown_key. */
export async function revoke(env: Env, kid: string): Promise<{ addr: string } | { error: "unknown_key" }> {
  const row = await env.DB.prepare("DELETE FROM passes WHERE id = ? RETURNING addr").bind(kid).first<{ addr: string }>();
  return row ? { addr: row.addr } : { error: "unknown_key" };
}

/** gate.revoked: из номеров — которых в базе больше нет; номер — kid или role.name.kid. */
export async function revoked(env: Env, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const kid = (id: string) => id.slice(id.lastIndexOf(".") + 1);
  const rows = await env.DB.prepare(`SELECT id FROM passes WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids.map(kid))
    .all<{ id: string }>();
  const live = new Set(rows.results.map((r) => r.id));
  return ids.filter((id) => !live.has(kid(id)));
}
