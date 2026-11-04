// Контракт gate: кто пришёл по пропуску. Пропуска — строки в базе D1 gate; секретов в базе нет, только sha256.
// Две двери: привязка внутри аккаунта (verify, revoke, revoked, list) и POST по адресу gate (keys.invite, keys.list, gate.redeem).

/** Кто пришёл: роль решает, кем соединение встанет в relay — машиной (host) или клиентом (client); addr — адрес отправителя. */
export type Verified = { role: "host" | "client"; name: string; kid: string; addr: string };

/**
 * Ответ verify. Отказ — значением со словом:
 * bad_key — пропуск не того вида, номера нет в базе (отзыв удаляет строку), секрет, роль или имя не сошлись.
 * Исключение значит «gate не ответил» (база не ответила, ошибка в коде) — двери отвечают словом gate_unavailable.
 */
export type VerifyResult = Verified | { error: "bad_key" };

/** Строка пропуска в keys.list: без хэша. */
export type Pass = {
  id: string;
  role: "host" | "client";
  name: string;
  person: string | null;
  addr: string;
  state: "wait" | "ok";
  by: string;
  at: number;
};

/** gate.verify, gate.revoke, gate.revoked, gate.list — методы входа Gate (привязка с "entrypoint": "Gate"). */
export interface GateApi {
  verify(key: string): Promise<VerifyResult>;
  /** Отзыв по номеру: строка удаляется. Номера нет — unknown_key. */
  revoke(kid: string): Promise<{ addr: string } | { error: "unknown_key" }>;
  /**
   * Какие из номеров отозваны: строки в базе больше нет. Номер — kid или role.name.kid.
   * push сверяет номера подписок на отправке.
   */
  revoked(ids: string[]): Promise<string[]>;
  /** Строки пропусков, как keys.list: с role — только принятые этой роли. Вход relay берёт отсюда машины флота. */
  list(role?: "host" | "client"): Promise<Pass[]>;
}

/**
 * Запросы POST по адресу gate. Тело — кадр JSON (Content-Type любой: страница шлёт text/plain без предзапроса),
 * ответ — reply {id, ok, result | error}.
 *   keys.invite {key, role, name, person?} → {kid, invite, addr}; person обязателен у client
 *   keys.list {key, role?} → {passes: Pass[], you}; с role — только принятые этой роли; you — адрес предъявленного пропуска
 *   gate.redeem {invite} → {key}; пропуска не нужно
 * Слова отказа: bad_key — пропуск; bad_request — поля не того вида; name_taken — у адреса есть живой пропуск;
 * bad_invite — приглашения нет, оно принято или отозвано; gate_unavailable — база не ответила.
 */
export const CONTRACT = { "keys.invite": 1, "keys.list": 1, "gate.redeem": 1 } as const;
export { entrance } from "./src/entrance.ts";
export { gateStand } from "./src/stand.ts";
