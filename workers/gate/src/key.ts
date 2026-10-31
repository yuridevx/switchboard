// Ключ флота: role.name.kid.sig, sig — HMAC-SHA256 секретом флота от role.name.kid в base64url.
// WebCrypto: один код для Worker gate и для инструмента invite в Node.
import type { VerifyResult } from "../contract.ts";

const PART = /^[A-Za-z0-9_-]+$/;
const ROLES = new Set(["host", "client"]);
const enc = new TextEncoder();

export type ParsedKey = { role: "host" | "client"; name: string; kid: string; sig: string; id: string };

/** Разобрать ключ без подписи. null — не четыре части, роль не host/client или недопустимые знаки. */
export function parseKey(key: unknown): ParsedKey | null {
  if (typeof key !== "string") return null;
  const p = key.split(".");
  if (p.length !== 4 || !p.every((x) => PART.test(x)) || !ROLES.has(p[0])) return null;
  return { role: p[0] as "host" | "client", name: p[1], kid: p[2], sig: p[3], id: `${p[0]}.${p[1]}.${p[2]}` };
}

function hmac(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function toB64url(b: ArrayBuffer): string {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Короткий случайный номер ключа: 4 знака a-z0-9. */
export function newKid(): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => a[x % a.length]).join("");
}

/** Выдать ключ: role.name.kid.sig. */
export async function sign(secret: string, role: "host" | "client", name: string, kid: string): Promise<string> {
  const id = `${role}.${name}.${kid}`;
  if (!parseKey(`${id}.x`)) throw new Error(`ключ ${id}: роль host или client, имя и номер — A-Z a-z 0-9 _ -`);
  const sig = await crypto.subtle.sign("HMAC", await hmac(secret, "sign"), enc.encode(id));
  return `${id}.${toB64url(sig)}`;
}

/**
 * Проверка ключа по шагам: вид → подпись → отзыв. Отказ — словом, строка журнала — в log.
 * Нет секрета — исключение: для relay это «gate не ответил».
 */
export async function verifyKey(
  key: unknown,
  secret: string | undefined,
  revoked: readonly string[],
  log: (line: string) => void,
): Promise<VerifyResult> {
  const p = parseKey(key);
  if (!p) {
    log("bad_key ключ не того вида: нужно role.name.kid.sig, роль host или client");
    return { error: "bad_key" };
  }
  if (!secret) {
    log("error FLEET_SECRET не задан");
    throw new Error("FLEET_SECRET не задан");
  }
  let sig: Uint8Array;
  try {
    sig = fromB64url(p.sig);
  } catch {
    sig = new Uint8Array();
  }
  const ok = await crypto.subtle.verify("HMAC", await hmac(secret, "verify"), sig as Uint8Array<ArrayBuffer>, enc.encode(p.id));
  if (!ok) {
    log(`bad_key ${p.id} · подпись не сошлась`);
    return { error: "bad_key" };
  }
  if (revoked.includes(p.id)) {
    log(`revoked ${p.id}`);
    return { error: "revoked" };
  }
  log(`ok ${p.id}`);
  return { role: p.role, name: p.name, kid: p.kid };
}
