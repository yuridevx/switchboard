// Ключ флота: role.name.kid.sig, sig — HMAC-SHA256 секретом флота от role.name.kid в base64url.
// WebCrypto: один код для Worker gate и для инструмента invite в Node.
import type { Verified } from "../contract.ts";

/** Старый ключ: роль, имя, номер — адрес ставит gate. */
export type LegacyResult = Omit<Verified, "addr"> | { error: "bad_key" | "revoked" };

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

/** Ключ проверки старой подписи (переход): выдачи старых ключей больше нет. */
function hmac(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
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

/**
 * Проверка ключа по шагам: вид → подпись → отзыв. Отказ — словом, строка журнала — в log.
 * Нет секрета — исключение: для relay это «gate не ответил».
 */
export async function verifyKey(
  key: unknown,
  secret: string | undefined,
  revoked: readonly string[],
  log: (line: string) => void,
): Promise<LegacyResult> {
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
  const ok = await crypto.subtle.verify("HMAC", await hmac(secret), sig as Uint8Array<ArrayBuffer>, enc.encode(p.id));
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

/** 32 случайных байта в base64url: секрет пропуска и приглашения. */
export function secret(): string {
  let s = "";
  for (const x of crypto.getRandomValues(new Uint8Array(32))) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
