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

/** Байты UTF-8 текста кадра, если он больше MAX_FRAME, иначе null. Текст до MAX_FRAME / 3 знаков заведомо в пределе — без подсчёта. */
export function oversize(text: string): number | null {
  if (text.length * 3 <= MAX_FRAME) return null;
  const bytes = new TextEncoder().encode(text).length;
  return bytes > MAX_FRAME ? bytes : null;
}

function isFrame(x: unknown): x is Frame {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const { type, id, v } = x as Record<string, unknown>;
  return typeof type === "string" && type !== "" && (id === undefined || typeof id === "string") && (v === undefined || typeof v === "number");
}

/** Разобрать текст кадра. Не JSON, не объект или нет строки type — null: кадр не по конверту, отказ словом bad_frame. */
export function parseFrame(text: string): Frame | null {
  try {
    const x: unknown = JSON.parse(text);
    return isFrame(x) ? x : null;
  } catch {
    return null;
  }
}

export const isReply = (f: Frame): f is Frame & Reply => f.type === "reply" && typeof f.id === "string" && typeof f.ok === "boolean";

export const ok = (id: string, result?: unknown): Reply => (result === undefined ? { type: "reply", id, ok: true } : { type: "reply", id, ok: true, result });

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
  if (typeof address !== "string" || address === "") return null;
  const tilde = address.indexOf("~");
  if (tilde >= 0) return tilde === address.length - 1 ? null : tilde === 0 ? "user" : "device";
  const at = address.indexOf("@");
  const noMachine = at === address.length - 1;
  if (!address.startsWith(".")) return at < 0 || noMachine ? null : at === 0 ? "machine" : "session";
  if (address === "." || at === 1 || noMachine) return null;
  return at < 0 ? "service" : "part";
}

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
export const reaches = (to: string, device: string): boolean => to === device || (kindOf(to) === "user" && kindOf(device) === "device" && userOf(device) === to);

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
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        resolve(late());
      } catch (e) {
        reject(e);
      }
    }, ms);
    Promise.resolve(p)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/** Значение или исключение со словами why за предел ms (по умолчанию CALL_MS). */
export const within = <T>(p: T | Promise<T>, why: string, ms: number = CALL_MS): Promise<T> =>
  withLimit(p, ms, () => {
    throw new Error(why);
  });
