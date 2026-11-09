// Контракт gate: кто пришёл по пропуску. Пропуска — строки в базе D1 gate; секретов в базе нет, только sha256.
// Вид пропуска — форма адреса (машина @laptop, устройство pult~ann@example.com, сессия site@laptop); грамматику знает protocol.
// Человек — его почта: владелец устройства — в адресе после ~, владелец машины — поле owner. Прав нет: любой живой пропуск может всё.
// Две двери: привязка внутри аккаунта (verify, revoke, list — это keys.list, redeem) и POST по адресу gate (keys.invite, keys.list,
// gate.redeem); по HTTP — вход OAuth внешних клиентов: метаданные сервера входа и /token.

/** Кто пришёл: номер пропуска и адрес отправителя; вид — форма адреса. */
export type Verified = { kid: string; addr: string };

/**
 * Ответ verify. Отказ — значением со словом:
 * bad_key — пропуск не того вида, номера нет в базе (отзыв удаляет строку), пропуск не принят, секрет не тот.
 * Исключение значит «gate не ответил» (база не ответила, ошибка в коде) — двери отвечают словом gate_unavailable.
 */
export type VerifyResult = Verified | { error: "bad_key" };

/** Строка keys.list: owner — только у машины; wait — приглашение ещё не принято. */
export type Pass = { kid: string; addr: string; owner: string | null; wait: boolean };

/** Фильтр keys.list: ids — эти номера (отозванных в ответе нет), kind — форма адреса. */
export type ListFilter = { ids?: string[]; kind?: "machine" | "device" | "session" };

export type Redeemed = { key: string; addr: string; kid: string };

/** keys.invite: адрес пропуска; owner — владелец машины; challenge, client и back — только у согласия OAuth. */
export type KeysInvite = { type: "keys.invite"; id: string; v?: 2; key?: string; addr: string; owner?: string; challenge?: string; client?: string; back?: string };
/** keys.list: все пропуска; ids — только эти номера, kind — только эта форма адреса. */
export type KeysList = { type: "keys.list"; id: string; v?: 2; key?: string } & ListFilter;

/** Методы входа Gate (привязка с "entrypoint": "Gate"): gate.verify, gate.revoke, keys.list, gate.redeem. */
export interface GateApi {
  verify(key: string): Promise<VerifyResult>;
  /** Отзыв по номеру: строка удаляется. Номера нет — unknown_key. */
  revoke(kid: string): Promise<{ addr: string } | { error: "unknown_key" }>;
  /** keys.list: машины флота для relay (kind machine), живые номера подписок push и чатов rooms (ids). */
  list(o?: ListFilter): Promise<Pass[]>;
  /** Приём приглашения тем, кто принимает его за чат: rooms. Та же запись, что gate.redeem по адресу. */
  redeem(invite: string): Promise<Redeemed | { error: "bad_invite" }>;
}

/**
 * Запросы POST по адресу gate. Тело — кадр JSON (Content-Type любой: страница шлёт text/plain без предзапроса),
 * ответ — reply {id, ok, result | error}.
 *   keys.invite {key, addr, owner?, challenge?, client?, back?} → {kid, invite, addr}; owner "~почта" — только у машины;
 *     challenge (PKCE S256), client (адрес описания клиента OAuth) и back (адрес возврата) — вместе, у согласия внешнего клиента:
 *     back gate сверяет с redirect_uris описания клиента
 *   keys.list {key, ids?, kind?} → {passes: Pass[], you}; you — адрес предъявленного пропуска
 *   gate.redeem {invite} → {key, addr, kid}; пропуска не нужно; приглашение живёт 24 часа
 * Слова отказа: bad_key — пропуск; bad_request — поля не того вида; name_taken — у адреса есть живой пропуск;
 * bad_client — описания клиента нет или в нём нет адреса возврата; bad_invite — приглашения нет, оно принято, отозвано,
 * старше суток или ждёт PKCE; gate_unavailable — база не ответила.
 * HTTP: GET /.well-known/oauth-authorization-server — метаданные (authorization_endpoint — страница согласия пульта);
 * POST /token (authorization_code, code — приглашение, code_verifier, client_id, redirect_uri) → access_token — пропуск устройства.
 */
export const CONTRACT = { "keys.invite": 2, "keys.list": 2, "gate.redeem": 1 } as const;
export { entrance } from "./src/entrance.ts";
export { inviteOf } from "./src/format.ts";
export { gateStand } from "./src/stand.ts";
