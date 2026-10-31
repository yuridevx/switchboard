// Контракт gate: проверка ключа флота. Вход Gate без публичного адреса — его зовёт только relay по привязке GATE.

/** Кто пришёл: роль решает, кем соединение встанет в relay — машиной (host) или клиентом (client). */
export type Verified = { role: "host" | "client"; name: string; kid: string };

/**
 * Ответ verify. Отказ — значением со словом:
 * bad_key — ключ не того вида или подпись не сошлась; revoked — номер ключа в REVOKED.
 * Исключение значит «gate не ответил» (нет FLEET_SECRET, ошибка в коде) — relay закрывает hello словом gate_unavailable.
 */
export type VerifyResult = Verified | { error: "bad_key" | "revoked" };

/** gate.verify — метод verify на входе Gate (привязка с "entrypoint": "Gate"). */
export interface GateApi {
  verify(key: string): Promise<VerifyResult>;
}
