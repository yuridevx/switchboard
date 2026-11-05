// Вид пропуска role.name.kid.secret и приглашения kid.secret. WebCrypto: один код для Worker'а gate и инструмента seed в Node.
export type Role = "host" | "client";
export type Key = { role: Role; name: string; kid: string; secret: string; id: string };

const KIND = /^[A-Za-z0-9_-]+$/;
const EMAIL = /^[^\s~@]+@[^\s~@]+$/;
const INVITE = /^([a-z0-9]{4})\.([A-Za-z0-9_-]{43})$/;
const KID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const isRole = (x: unknown): x is Role => x === "host" || x === "client";
export const isName = (x: unknown): x is string => typeof x === "string" && KIND.test(x);
export const isPerson = (x: unknown): x is string => typeof x === "string" && EMAIL.test(x);

export function parseKey(key: unknown): Key | null {
  if (typeof key !== "string") return null;
  const parts = key.split(".");
  if (parts.length !== 4 || !parts.every(isName)) return null;
  const [role, name, kid, secret] = parts;
  return isRole(role) ? { role, name, kid, secret, id: `${role}.${name}.${kid}` } : null;
}

export function parseInvite(invite: unknown): { kid: string; secret: string } | null {
  const m = typeof invite === "string" ? INVITE.exec(invite) : null;
  return m && { kid: m[1], secret: m[2] };
}

export const newKid = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => KID_ALPHABET[b % KID_ALPHABET.length]).join("");

/** 32 случайных байта в base64url: секрет пропуска и приглашения. */
export function newSecret(): string {
  const text = String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)));
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
