// Конверт кадра: type, id, reply, v, адрес и from. Имён кадров модулей не знает.

/** Кадр рации. Поля владельца имени лежат рядом с конвертом. */
export type Frame = {
  type: string;
  /** у запроса: ждёт reply с тем же id */
  id?: string;
  /** версия имени у запроса */
  v?: number;
  /** адрес: сессия site@laptop, машина @laptop, часть машины .keeper@laptop, служба .push, пользователь ~email, устройство phone~email */
  to?: string | string[];
  /** Host машины этой сессии */
  callsign?: string;
  /** Host этой машины */
  machine?: string;
  /** отправитель — ставит relay */
  from?: string;
  [field: string]: unknown;
};

export type Reply =
  | { type: "reply"; id: string; ok: true; result?: unknown; from?: string; to?: string | string[] }
  | { type: "reply"; id: string; ok: false; error: string; from?: string; to?: string | string[] };

/** Слово отказа общего конверта: кадр не JSON или нет type. */
export const BAD_FRAME = "bad_frame";

/** Предел кадра в байтах UTF-8: входящее сообщение WebSocket в Durable Object Cloudflare — до 32 МиБ. */
export const MAX_FRAME = 32 * 1024 * 1024;

/** Слово отказа: кадр больше MAX_FRAME не отправлен; рядом — bytes. */
export const TOO_LARGE = "too_large";

/** Байты UTF-8 текста кадра, если он больше MAX_FRAME, иначе null. Текст до MAX_FRAME / 3 знаков заведомо в пределе — без подсчёта. */
export function oversize(text: string): number | null {
  if (text.length * 3 <= MAX_FRAME) return null;
  const bytes = new TextEncoder().encode(text).length;
  return bytes > MAX_FRAME ? bytes : null;
}

/** Разобрать текст кадра. Не JSON, не объект или нет строки type — null: кадр не по конверту, отказ словом bad_frame. */
export function parseFrame(text: string): Frame | null {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return null;
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const f = x as Record<string, unknown>;
  if (typeof f.type !== "string" || !f.type) return null;
  if (f.id !== undefined && typeof f.id !== "string") return null;
  if (f.v !== undefined && typeof f.v !== "number") return null;
  return f as Frame;
}

export function isReply(f: Frame): f is Frame & Reply {
  return f.type === "reply" && typeof f.id === "string" && typeof f.ok === "boolean";
}

export function ok(id: string, result?: unknown): Reply {
  return result === undefined ? { type: "reply", id, ok: true } : { type: "reply", id, ok: true, result };
}

export function fail(id: string, error: string): Reply {
  return { type: "reply", id, ok: false, error };
}

/**
 * Вид адреса по его форме:
 *   .имя            служба флота (Worker-модуль): .relay, .releases
 *   .имя@машина     системная часть машины: .keeper@win
 *   @машина         сама машина — её Host: @win
 *   имя@машина      сессия: site@win
 *   ~email          пользователь: ~yuri@example.com
 *   устройство~email  устройство пользователя: phone~yuri@example.com
 * Точка в начале — системное имя; тильда — человек, справа от неё email как есть. Голое имя — не адрес.
 */
export type AddressKind = "service" | "part" | "machine" | "session" | "user" | "device";

export function kindOf(address: unknown): AddressKind | null {
  if (typeof address !== "string" || !address) return null;
  const t = address.indexOf("~");
  if (t >= 0) {
    if (t === address.length - 1) return null;
    return t === 0 ? "user" : "device";
  }
  const at = address.indexOf("@");
  if (address.startsWith(".")) {
    if (address.length < 2 || at === 1) return null;
    return at < 0 ? "service" : at === address.length - 1 ? null : "part";
  }
  if (at < 0 || at === address.length - 1) return null;
  return at === 0 ? "machine" : "session";
}

/** Машина адреса: site@laptop, @laptop, .keeper@laptop → laptop; служба и люди — null. */
export function machineOf(address: string): string | null {
  const k = kindOf(address);
  if (k !== "machine" && k !== "session" && k !== "part") return null;
  return address.slice(address.indexOf("@") + 1);
}

/** Доходит ли адрес to до устройства: адрес человека ~email — до всех его устройств x~email, адрес устройства — только до него самого. */
export function reaches(to: string, device: string): boolean {
  return to === device || (kindOf(to) === "user" && kindOf(device) === "device" && device.endsWith(to));
}

/** Адрес службы флота по имени Worker-модуля: points → .points. */
export const serviceAddress = (name: string) => `.${name}`;
