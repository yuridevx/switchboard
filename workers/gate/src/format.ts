// Вид пропуска и приглашения, выпуск секрета, правила полей. Без платформы: то же в Worker и в seed.

/** Пропуск: role.name.kid.secret. */
export const PASS = /^(host|client)\.([\w-]+)\.([\w-]+)\.([\w-]+)$/;
/** Приглашение: номер.секрет. */
export const INVITE = /^([a-z0-9]{4})\.([\w-]{43})$/;

const KID_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

export const newKid = (): string => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => KID_LETTERS[b % KID_LETTERS.length]).join("");

/** 32 случайных байта в base64url: 43 знака. */
export const newSecret = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Что не так с полями новой строки; всё верно — null. */
export function fieldsWrong(role: unknown, name: unknown, person: unknown): string | null {
  if (role !== "host" && role !== "client") return "role — host или client";
  if (typeof name !== "string" || !/^[\w-]+$/.test(name)) return "name — A-Z a-z 0-9 _ -";
  if (role === "host") return person === undefined ? null : "у машины person нет";
  return typeof person === "string" && /^[^\s~@]+@[^\s~@]+$/.test(person) ? null : "person — почта человека за устройством или программой";
}
