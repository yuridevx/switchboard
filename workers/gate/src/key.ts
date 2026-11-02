// Пропуск role.name.kid.secret: разбор, номер, секрет и его хэш. WebCrypto: один код для Worker gate и для инструментов в Node.
const PART = /^[A-Za-z0-9_-]+$/;
const ROLES = new Set(["host", "client"]);

export type ParsedKey = { role: "host" | "client"; name: string; kid: string; sig: string; id: string };

/** Разобрать пропуск. null — не четыре части, роль не host/client или недопустимые знаки. */
export function parseKey(key: unknown): ParsedKey | null {
  if (typeof key !== "string") return null;
  const p = key.split(".");
  if (p.length !== 4 || !p.every((x) => PART.test(x)) || !ROLES.has(p[0])) return null;
  return { role: p[0] as "host" | "client", name: p[1], kid: p[2], sig: p[3], id: `${p[0]}.${p[1]}.${p[2]}` };
}

/** Короткий случайный номер ключа: 4 знака a-z0-9. */
export function newKid(): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => a[x % a.length]).join("");
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
