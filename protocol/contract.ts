// Общий конверт кадра рации: type, id, reply; адреса по форме; пределы ожидания. Имён кадров модулей не знает.

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

// ---------- конверт ----------

/** Слово отказа общего конверта: кадр не JSON или нет type. */
export const BAD_FRAME = "bad_frame";
/** Слово отказа: кадр больше MAX_FRAME не отправлен; рядом — bytes. */
export const TOO_LARGE = "too_large";
/** Предел кадра в байтах UTF-8: входящее сообщение WebSocket в Durable Object Cloudflare — до 32 МиБ. */
export const MAX_FRAME = 32 * 1024 * 1024;

/** Байты UTF-8 текста, если их больше MAX_FRAME, иначе null. */
export function oversize(text: string): number | null {
  const bytes = new TextEncoder().encode(text).length;
  return bytes > MAX_FRAME ? bytes : null;
}

/** Текст кадра или null: не JSON, не объект, нет строки type, id не строка, v не число. */
export function parseFrame(text: string): Frame | null {
  let x;
  try {
    x = JSON.parse(text);
  } catch {
    return null;
  }
  return x?.type && typeof x.type === "string" && (x.id === undefined || typeof x.id === "string") && (x.v === undefined || typeof x.v === "number") ? x : null;
}

export const isReply = (f: Frame): f is Frame & Reply => f.type === "reply" && typeof f.id === "string" && typeof f.ok === "boolean";

export const ok = (id: string, result?: unknown): Reply => ({ type: "reply", id, ok: true, result });

export const fail = (id: string, error: string): Reply => ({ type: "reply", id, ok: false, error });

/**
 * Приём запроса по договору получателя: имя обслуживается и версия совпадает, v обязателен.
 * null — принят; иначе слово отказа с причиной. Одно правило для ядра Host и служб флота.
 */
export function accepts(f: { type: string; v?: unknown }, provides: Record<string, number>): { word: "unknown_request" | "contract_mismatch"; why: string } | null {
  if (!Object.hasOwn(provides, f.type)) return { word: "unknown_request", why: `${f.type} не обслуживается` };
  const v = provides[f.type];
  return f.v === v ? null : { word: "contract_mismatch", why: `${f.type} — запрошена v${f.v ?? "—"}, здесь v${v}` };
}

// ---------- адреса ----------

export type AddressKind = "service" | "part" | "machine" | "session" | "user" | "device";

/** Формы адреса. Тильда — человек, справа от неё email как есть; точка в начале — системное имя; голое имя — не адрес. */
const FORMS: Array<[AddressKind, RegExp]> = [
  ["user", /^~.+$/], // ~yuri@example.com
  ["device", /^[^~]+~.+$/], // phone~yuri@example.com
  ["service", /^\.[^@~]+$/], // .relay
  ["part", /^\.[^@~]+@[^~]+$/], // .keeper@win
  ["machine", /^@[^~]+$/], // @win
  ["session", /^[^.@~][^@~]*@[^~]+$/], // site@win
];

export const kindOf = (address: unknown): AddressKind | null => (typeof address === "string" && FORMS.find(([, form]) => form.test(address))?.[0]) || null;

/** Машина адреса: site@laptop, @laptop, .keeper@laptop → laptop; служба и люди — null. */
export function machineOf(address: string): string | null {
  const kind = kindOf(address);
  return kind === "machine" || kind === "session" || kind === "part" ? address.slice(address.indexOf("@") + 1) : null;
}

/** Имя сессии адреса: site@laptop → site; без машины — как есть. */
export const nameOf = (address: string): string => address.split("@", 1)[0];

/** Пользователь адреса: phone~a@b.c и ~a@b.c → ~a@b.c; машина, сессия, служба — null. Одно правило для протокола, prefs и веба. */
export function userOf(address: string): string | null {
  const kind = kindOf(address);
  return kind === "user" || kind === "device" ? address.slice(address.indexOf("~")) : null;
}

/** Доходит ли адрес to до устройства: адрес человека ~email — до всех его устройств x~email, адрес устройства — только до него самого. */
export const reaches = (to: string, device: string): boolean => to === device || to === userOf(device);

/** Адрес человека: он сам или его устройство. */
export const isPerson = (a: unknown): boolean => kindOf(a) === "user" || kindOf(a) === "device";

/**
 * Машина, чьему Host адресован кадр: по to, иначе по callsign, иначе по machine — одно правило для рации, Host и веба.
 * to — не Host машины (служба, часть машины, человек, устройство) — null; callsign не адрес сессии — null; адреса нет — undefined.
 */
export function hostOf(f: { to?: unknown; callsign?: unknown; machine?: unknown }): string | null | undefined {
  if (typeof f.to === "string") return kindOf(f.to) === "machine" || kindOf(f.to) === "session" ? machineOf(f.to) : null;
  if (typeof f.callsign === "string") return kindOf(f.callsign) === "session" ? machineOf(f.callsign) : null;
  return typeof f.machine === "string" ? f.machine : undefined;
}

/** Адрес службы флота по имени Worker-модуля: points → .points. */
export const serviceAddress = (name: string): string => `.${name}`;

// ---------- пределы ----------

/**
 * Предел ожидания вызова другой части — по привязке или fetch: как предел запроса клиента флота (120 с). Кто ждёт
 * ответа части дольше, тот сам уже получил отказ timeout — держать вызов сверх этого незачем.
 */
export const CALL_MS = 120_000;

/**
 * Предел запроса, который только читает состояние (слово пользователя 4 нояб.: «таймаут операций на запрос метадаты 10 секунд»).
 * Предел по адресату: опоздавшая машина не задерживает ответы остальных. Что считается чтением, говорит вызывающий.
 */
export const READ_MS = 10_000;

/** Предел операции: не успела за ms — ответ late (бросила — отказ). Саму операцию не прерывает: что прервать, знает вызывающий. Слово пользователя 2 нояб.: у всех операций лимит. */
export function withLimit<T>(p: T | Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(new Promise<T>((r) => r(late()))), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Значение или исключение со словами why за предел ms (по умолчанию CALL_MS). */
export const within = <T>(p: T | Promise<T>, why: string, ms: number = CALL_MS): Promise<T> =>
  withLimit(p, ms, () => {
    throw new Error(why);
  });
