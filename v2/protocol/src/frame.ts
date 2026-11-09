// Конверт кадра, адреса, пропуск, пределы и слова отказа. Имён запросов модулей не знает.

/** Отрезок пути запроса: какая часть сколько работала. Каждая часть на обратном пути дописывает свой. */
export type Span = { part: string; ms: number };

/** Кадр. Поля владельца имени лежат рядом с конвертом. */
export type Frame = {
  type: string;
  /** у запроса: ждёт reply с тем же id */
  id?: string;
  /** адресат: сессия `site@laptop`, машина `@laptop`, человек `~a@b.c`, устройство `pult~a@b.c` */
  to?: string | string[];
  /** отправитель; ставит вход, не клиент */
  from?: string;
  /** сквозной номер запроса: рождается у того, кто начал, идёт через все части и в журналы */
  trace?: string;
  [field: string]: unknown;
};

export type Reply = {
  type: "reply";
  id: string;
  ok: boolean;
  result?: unknown;
  /** слово отказа */
  error?: string;
  /** причина словами для человека и журнала */
  why?: string;
  trace?: string;
  spans?: Span[];
};

export const CALL_MS = 120_000;
export const READ_MS = 10_000;
export const MAX_FRAME = 32 * 1024 * 1024;
/** Версия конверта: меняется только при несовместимой правке самого конверта. */
export const PROTO = 2;

/** Общие слова отказа; свои слова модуль называет в своём договоре. */
export const WORDS = {
  bad_frame: "кадр не разобран",
  bad_input: "ввод не подходит под схему",
  bad_key: "пропуск не принят",
  forbidden: "нет права",
  unknown_request: "такого запроса здесь нет",
  offline: "адресат не на связи",
  timeout: "ответа нет за отведённое время",
  module_failed: "ошибка в модуле",
  too_large: "кадр больше предела",
  not_found: "не найдено",
} as const;
export type Word = keyof typeof WORDS;

/** Отказ словом: бросается в обработчике, вход превращает его в reply. */
export class Refusal extends Error {
  word: string;
  why?: string;
  constructor(word: string, why?: string) {
    super(why ? `${word}: ${why}` : word);
    this.word = word;
    this.why = why;
  }
}

export const ok = (id: string, result?: unknown): Reply => (result === undefined ? { type: "reply", id, ok: true } : { type: "reply", id, ok: true, result });
export const fail = (id: string, error: string, why?: string): Reply => (why ? { type: "reply", id, ok: false, error, why } : { type: "reply", id, ok: false, error });
export const isReply = (f: Frame): f is Reply => f.type === "reply" && typeof f.id === "string" && typeof f.ok === "boolean";

/** Разбор текста кадра; не кадр — null. */
export function parseFrame(text: string): Frame | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const f = v as Frame;
  if (typeof f.type !== "string" || !f.type) return null;
  if (f.id !== undefined && typeof f.id !== "string") return null;
  return f;
}

let seq = 0;
/** Короткий случайный номер: для id запроса и trace. */
export function newId(prefix = ""): string {
  const r = crypto.getRandomValues(new Uint8Array(9));
  let s = "";
  for (const b of r) s += b.toString(36).padStart(2, "0");
  return prefix + s.slice(0, 12) + (seq++ % 36).toString(36);
}

/* ===== Адреса =====
   служба `.archive` · keeper машины `.keeper@laptop` · машина `@laptop` · сессия `site@laptop` · человек `~a@b.c` · устройство `pult~a@b.c` */

export type AddrKind = "service" | "keeper" | "machine" | "session" | "person" | "device";

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const EMAIL = /^[^\s@~]+@[^\s@~]+\.[^\s@~]+$/;

export function kindOf(a: unknown): AddrKind | null {
  if (typeof a !== "string" || !a) return null;
  const tilde = a.indexOf("~");
  if (tilde >= 0) {
    const dev = a.slice(0, tilde), mail = a.slice(tilde + 1);
    if (!EMAIL.test(mail)) return null;
    if (!dev) return "person";
    return NAME.test(dev) ? "device" : null;
  }
  const at = a.indexOf("@");
  if (a.startsWith(".")) {
    if (at < 0) return NAME.test(a.slice(1)) ? "service" : null;
    return a.slice(1, at) === "keeper" && NAME.test(a.slice(at + 1)) ? "keeper" : null;
  }
  if (at < 0) return null;
  const name = a.slice(0, at), machine = a.slice(at + 1);
  if (!NAME.test(machine)) return null;
  if (!name) return "machine";
  return NAME.test(name) ? "session" : null;
}

/** Машина адреса: у сессии, машины и keeper; иначе null. */
export function machineOf(a: string): string | null {
  const k = kindOf(a);
  return k === "session" || k === "machine" || k === "keeper" ? a.slice(a.indexOf("@") + 1) : null;
}

/** Человек адреса: `~почта` у человека и устройства; иначе null. */
export function personOf(a: string): string | null {
  const k = kindOf(a);
  return k === "person" || k === "device" ? a.slice(a.indexOf("~")) : null;
}

export const sessionName = (callsign: string): string => callsign.slice(0, callsign.indexOf("@"));
export const machineAddr = (machine: string): string => "@" + machine;
export const keeperAddr = (machine: string): string => ".keeper@" + machine;

/* ===== Пропуск =====
   `флот:номер:секрет`. Кто за ним стоит, знает только объект флота; хранится хэш секрета. Приглашение — той же формы. */

export type Pass = { fleet: string; kid: string; secret: string };

export function parsePass(key: unknown): Pass | null {
  if (typeof key !== "string") return null;
  const p = key.split(":");
  if (p.length !== 3) return null;
  const [fleet, kid, secret] = p as [string, string, string];
  if (!NAME.test(fleet) || !/^[a-z0-9]{6,32}$/.test(kid) || secret.length < 16) return null;
  return { fleet, kid, secret };
}

export const formatPass = (p: Pass): string => `${p.fleet}:${p.kid}:${p.secret}`;

export async function sha256hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Кто пришёл — ответ объекта флота на пропуск. */
export type Who = {
  kid: string;
  /** адрес предъявителя: устройство, машина или сессия (машина назвала позывной) */
  addr: string;
  /** человек, от чьего имени он действует: владелец машины или хозяин устройства */
  person: string;
  admin: boolean;
  /** машины, до которых достаёт */
  machines: string[];
};

/** Достаёт ли пришедший до машины: правило считает объект флота, здесь — только сверка со списком. */
export const canReach = (who: Pick<Who, "machines">, machine: string): boolean => who.machines.includes(machine);

/** Предел ожидания: успела — её ответ, нет — отказ timeout. */
export function within<T>(p: Promise<T> | T, ms = CALL_MS, why = "нет ответа"): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Refusal("timeout", why)), ms);
    Promise.resolve(p).then(
      (v) => (clearTimeout(t), res(v)),
      (e) => (clearTimeout(t), rej(e)),
    );
  });
}
