// Конверт кадра: type, id, reply, v, адрес и from. Имён кадров модулей не знает.

/** Кадр рации. Поля владельца имени лежат рядом с конвертом. */
export type Frame = {
  type: string;
  /** у запроса: ждёт reply с тем же id */
  id?: string;
  /** версия имени у запроса */
  v?: number;
  /** адрес: сессия site@laptop, машина @laptop, клиент phone, Worker-модуль push */
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

/** Разобрать текст кадра. Не JSON, не объект или нет строки type — bad_frame. */
export function parseFrame(text: string): Frame | { error: typeof BAD_FRAME } {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return { error: BAD_FRAME };
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) return { error: BAD_FRAME };
  const f = x as Record<string, unknown>;
  if (typeof f.type !== "string" || !f.type) return { error: BAD_FRAME };
  if (f.id !== undefined && typeof f.id !== "string") return { error: BAD_FRAME };
  if (f.v !== undefined && typeof f.v !== "number") return { error: BAD_FRAME };
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

/** Адрес сессии site@laptop → машина laptop; адрес машины @laptop → laptop; иначе — null. */
export function machineOf(address: string): string | null {
  const i = address.indexOf("@");
  if (i < 0) return null;
  const m = address.slice(i + 1);
  return m ? m : null;
}
