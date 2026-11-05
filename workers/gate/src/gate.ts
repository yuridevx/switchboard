// Правила пропусков: проверка, приглашение, приём, список. Отказ — слово и причина для журнала; строка базы — правда о роли и имени.
import type { Pass, Verified, VerifyResult } from "../contract.ts";
import { isName, isPerson, isRole, newKid, newSecret, parseInvite, parseKey, sha256 } from "./format.ts";
import { accept, addWaiting, findPass, listPasses } from "./passes.ts";

export type Log = (line: string) => void;
export type Refusal = { error: string; why: string };

const refuse = (error: string, why: string): Refusal => ({ error, why });
const BAD_ROLE = "role — host или client";
/** Номер — 4 знака: совпал с занятым — следующая попытка. */
const KID_TRIES = 3;

export async function verify(db: D1Database, key: unknown, log: Log): Promise<VerifyResult> {
  const pass = parseKey(key);
  if (!pass) {
    log("bad_key пропуск не того вида: нужно role.name.kid.secret, роль host или client");
    return { error: "bad_key" };
  }
  const started = Date.now();
  const row = await findPass(db, pass.kid);
  const ms = Date.now() - started;
  const denied = (why: string): VerifyResult => {
    log(`bad_key ${pass.id} · ${why} · ${ms} мс`);
    return { error: "bad_key" };
  };
  if (!row) return denied("номера нет в базе");
  if (row.state === "wait") return denied("пропуск не принят");
  if (row.role !== pass.role || row.name !== pass.name || row.hash !== (await sha256(pass.secret))) return denied("не сошлись секрет, роль или имя");
  log(`ok ${pass.id} → ${row.addr} · ${ms} мс`);
  return { role: pass.role, name: pass.name, kid: pass.kid, addr: row.addr };
}

export async function invite(db: D1Database, by: Verified, f: Record<string, unknown>): Promise<{ kid: string; invite: string; addr: string } | Refusal> {
  const { role, name, person } = f;
  if (!isRole(role)) return refuse("bad_request", BAD_ROLE);
  if (!isName(name)) return refuse("bad_request", "name — A-Z a-z 0-9 _ -");
  if (role === "client" && !isPerson(person)) return refuse("bad_request", "person — почта человека за устройством или программой");
  if (role === "host" && person !== undefined) return refuse("bad_request", "у машины person нет");
  const code = newSecret();
  const hash = await sha256(code);
  for (let tries = 0; tries < KID_TRIES; tries++) {
    const kid = newKid();
    try {
      const addr = await addWaiting(db, { kid, role, name, person: role === "client" ? (person as string) : null, hash, by: by.addr });
      if (addr) return { kid, invite: `${kid}.${code}`, addr };
    } catch (e) {
      if (!String((e as Error).message).includes("UNIQUE")) throw e;
      return refuse("name_taken", `у адреса ${role === "host" ? `@${name}` : `${name}~${person}`} есть живой пропуск`);
    }
  }
  throw new Error("три номера подряд заняты");
}

export async function redeem(db: D1Database, f: Record<string, unknown>): Promise<{ key: string } | Refusal> {
  const inv = parseInvite(f.invite);
  if (!inv) return refuse("bad_invite", "приглашение не того вида: номер.секрет");
  const secret = newSecret();
  const row = await accept(db, inv.kid, await sha256(inv.secret), await sha256(secret));
  return row ? { key: `${row.role}.${row.name}.${inv.kid}.${secret}` } : refuse("bad_invite", `приглашения ${inv.kid} нет, оно принято или отозвано`);
}

export async function list(db: D1Database, f: Record<string, unknown>): Promise<{ passes: Pass[] } | Refusal> {
  const { role } = f;
  if (role === undefined) return { passes: await listPasses(db) };
  return isRole(role) ? { passes: await listPasses(db, role) } : refuse("bad_request", BAD_ROLE);
}
