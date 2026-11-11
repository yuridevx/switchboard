// Формат пропуска и приглашения: подпись.номер.секрет и номер.секрет. Секрет живёт только у владельца; база хранит sha256.
// Подпись — имя адреса для человека на экране отказа: gate её не сверяет, кто это — знает строка по номеру.
// Поэтому прежние пропуска role.name.номер.секрет проходят verify как есть: выданные не перевыдаются.
import { kindOf, userOf } from "@switchboard/protocol";

/** Группы: подпись, номер, секрет. Текстом подставляется в стенд. */
export const PASS = /^([\w-]+(?:\.[\w-]+)*)\.([\w-]+)\.([\w-]+)$/;
/** Группы: номер, секрет. */
export const INVITE = /^([a-z0-9]{4})\.([\w-]{43})$/;

/** Приглашение в тексте: в ссылке точка заменена на _, Telegram не принимает её в параметре. Не оно — null. */
export function inviteOf(text: string): string | null {
  const m = /^([a-z0-9]{4})[._]([\w-]{43})$/.exec(text.trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

const NAME = /^[\w-]+$/;
const PERSON = /^~[^\s@~]+@[^\s@~]+$/;
const CHALLENGE = /^[\w-]{43}$/;
const KID_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Виды пропуска — формы адреса. */
export const KINDS = ["machine", "device", "session"] as const;
export type Kind = (typeof KINDS)[number];

const https = (u: unknown) => {
  try {
    return typeof u === "string" && new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};
const url = (u: unknown) => {
  try {
    return typeof u === "string" && /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};

/** Что не так в полях выдачи или null. owner — только у машины; challenge, client и back — вместе и только у устройства. */
export function fieldsWrong(f: { addr?: unknown; owner?: unknown; challenge?: unknown; client?: unknown; back?: unknown }): string | null {
  const { addr } = f;
  const kind = kindOf(addr);
  if (typeof addr !== "string" || !(KINDS as readonly string[]).includes(kind ?? "")) return "addr — @машина, устройство~почта или сессия@машина";
  const [name, place] = kind === "device" ? [addr.slice(0, addr.indexOf("~")), userOf(addr)] : [addr.split("@")[0], addr.slice(addr.indexOf("@") + 1)];
  if (kind === "device" ? !NAME.test(name) || !PERSON.test(place ?? "") : !NAME.test(place ?? "") || (kind === "session" && !/^[\w.-]+$/.test(name))) return "addr — имена A-Z a-z 0-9 _ -, почта человека после ~";
  if (f.owner !== undefined && (kind !== "machine" || typeof f.owner !== "string" || !PERSON.test(f.owner))) return "owner — ~почта, только у машины";
  const oauth = [f.challenge, f.client, f.back].filter((x) => x !== undefined).length;
  if (oauth && (oauth < 3 || kind !== "device")) return "challenge, client и back — вместе и только у устройства";
  if (oauth && (typeof f.challenge !== "string" || !CHALLENGE.test(f.challenge) || !https(f.client) || !url(f.back))) return "challenge — S256 в base64url, client — https, back — адрес";
  return null;
}

/** Подпись пропуска из адреса: pult~ann@example.com → pult, @laptop → laptop, site@laptop → site. */
export const labelOf = (addr: string): string => (kindOf(addr) === "machine" ? addr.slice(1) : addr.split(/[~@]/)[0]).replace(/[^\w-]/g, "-");

export const newKid = (): string => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => KID_LETTERS[b % KID_LETTERS.length]).join("");

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** 32 случайных байта в base64url: 43 знака. */
export const newSecret = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** PKCE S256: challenge из verifier. */
export const s256 = async (verifier: string): Promise<string> => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
