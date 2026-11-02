// Контракт relay: кадры рации, вход участников и клиент link.
// Всё, что нужно другим модулям от relay, — только отсюда.
import type { Frame } from "@switchboard/protocol";

export type { Frame, Reply } from "@switchboard/protocol";
/**
 * link(options) — клиент relay: hello, запросы с id и ожиданием reply, ping, переподключение.
 * PROTO — версия контракта relay, которую link шлёт в hello; relay принимает версии из своей настройки PROTO.
 * Пример (Host):
 *   const l = link({ url, key, hello: () => ({ sdk, contract, sessions }), onFrame, onState });
 *   const r = await l.request({ type: "message", to: "poe-bot@pc", text: "…" });
 *   // r: { type: "reply", id, ok: true, result } | { …, ok: false, error: "offline" | "disconnected" | … }
 *   l.send({ type: "reply", id: req.id, to: req.from, ok: true, result });  // ответ на чужой запрос
 */
export { link, PROTO } from "./src/link.ts";
export type { Link, LinkOptions, LinkState, WsLike, WsCtor } from "./src/link.ts";

/** Слова отказа relay. Слова gate (bad_key, revoked) relay передаёт как есть. */
export type RelayWord = "bad_frame" | "bad_from" | "offline" | "contract_mismatch" | "gate_unavailable";

/**
 * Закрытие соединения relay: код и слово в причине.
 * 1008 — отказ: bad_frame, bad_key, revoked, bad_from, contract_mismatch, gate_unavailable.
 * 1000 replaced — машину вытеснил новый hello с тем же именем.
 */
export const CLOSE_REFUSED = 1008;
export const CLOSE_REPLACED = 1000;
export const REPLACED = "replaced";

/** Запись сессии в карточке Host: callsign и поля модулей Host — relay их не читает. */
export type SessionRecord = { callsign: string; state?: string | null; [field: string]: unknown };

/**
 * hello — первый кадр соединения. key — ключ флота role.name.kid.sig.
 * Host шлёт ещё sdk, contract (provides модулей) и sessions; клиент — только key и proto.
 * keeper машины входит ключом машины и шлёт part: "keeper" — его адрес .keeper@машина, в roster его нет.
 */
export type HelloFrame = {
  type: "hello";
  key: string;
  proto: number;
  sdk?: string;
  contract?: Record<string, number>;
  sessions?: SessionRecord[];
  /** часть машины, которая входит ключом машины: keeper */
  part?: "keeper";
};

/**
 * session.state — Host сообщает о своей сессии: запись заменяется целиком,
 * state: null убирает её. callsign — только своей машины, иначе bad_from.
 */
export type SessionStateFrame = { type: "session.state"; callsign: string; state: string | null; [field: string]: unknown };

export type RosterMachine = {
  machine: string;
  /** время hello машины, мс; новое since — новое соединение машины */
  since: number;
  proto: number;
  sdk?: string;
  contract?: Record<string, number>;
};
export type RosterWorker = { name: string; contract: Record<string, number> };

/**
 * roster — relay шлёт всем соединениям после каждого hello, session.state и ухода соединения,
 * и участникам, у кого в uses есть roster@relay. Собран из карточек живых соединений
 * и ответов hello() участников.
 */
export type Roster = {
  type: "roster";
  machines: RosterMachine[];
  sessions: SessionRecord[];
  clients: string[];
  workers: RosterWorker[];
};

/** Ответ участника на hello(): его контракт и, если нужен roster, uses: { "roster@relay": 1 }. */
export type ParticipantHello = { contract: Record<string, number>; uses?: Record<string, number> };

/**
 * Вход участника — Worker-модуля на рации (класс Participant в его пакете).
 * relay зовёт hello() при старте объекта флота и frame(кадр) — для кадров с to = имя участника
 * (кадр как есть плюс from). Ответ frame — кадры, которые relay доставит от имени участника (from ставит relay),
 * по порядку; отказ одному из них — строка в журнале relay, остальные идут. Исключение из frame — отправителю offline.
 */
export interface Participant {
  hello(): ParticipantHello | Promise<ParticipantHello>;
  frame(f: Frame): Frame[] | Promise<Frame[]>;
}

/**
 * Вход Radio relay — для участников, через свою привязку RELAY с props { name }.
 * frame(кадр): свой кадр или reply; from ставит relay из props.name.
 * Ответ: undefined — передан; слово — отказ (offline, bad_from, bad_frame).
 */
export interface Radio {
  frame(f: Frame): Promise<RelayWord | undefined>;
}
