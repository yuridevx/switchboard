// Формат пропуска и приглашения: роль.имя.номер.секрет и номер.секрет. Без импортов: файл берут Worker, стенд и seed.
// Секрет живёт только у владельца; база хранит sha256.

/** Группы: роль, имя, номер, секрет. Текстом подставляется в стенд. */
export const PASS = /^(host|client)\.([\w-]+)\.([\w-]+)\.([\w-]+)$/;
/** Группы: номер, секрет. */
export const INVITE = /^([a-z0-9]{4})\.([\w-]{43})$/;

/** Приглашение в тексте: в ссылке точка заменена на _, Telegram не принимает её в параметре. Не оно — null. */
export function inviteOf(text: string): string | null {
  const m = /^([a-z0-9]{4})[._]([\w-]{43})$/.exec(text.trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

const NAME = /^[\w-]+$/;
const PERSON = /^[^\s@~]+@[^\s@~]+$/;
const KID_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Что не так в полях выдачи или null. */
export function fieldsWrong(f: { role?: unknown; name?: unknown; person?: unknown }): string | null {
  if (f.role !== "host" && f.role !== "client") return "role — host или client";
  if (typeof f.name !== "string" || !NAME.test(f.name)) return "name — A-Z a-z 0-9 _ -";
  if (f.role === "host") return f.person === undefined ? null : "у машины person нет";
  return typeof f.person === "string" && PERSON.test(f.person) ? null : "person — почта человека за устройством или программой";
}

export const newKid = (): string => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => KID_LETTERS[b % KID_LETTERS.length]).join("");

/** 32 случайных байта в base64url: 43 знака. */
export function newSecret(): string {
  const text = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  return text.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
