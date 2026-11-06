// Контракт fleetkeys: ключи API на весь флот. Заводятся один раз на пульте; на каждой машине ключ становится слотом.
// env — родные переменные Claude (адрес ANTHROPIC_BASE_URL, модели alias, окно), settings — JSON настроек Claude; значений служба не читает.
// Значение ключа наружу отдаёт только fleetkeys.key пропуску машины. Запросы — кадры с to: ".fleetkeys", прямым POST с пропуском.

export const CONTRACT = { "fleetkeys.list": 1, "fleetkeys.set": 1, "fleetkeys.remove": 1, "fleetkeys.key": 1 } as const;

/** Имя ключа — те же знаки, что у слота: оно становится папкой на машине. */
export const KEY_NAME = /^[A-Za-z0-9_-]+$/;

export type KeyConfig = { env: Record<string, string>; settings: Record<string, unknown> };

/** fleetkeys.list → все ключи без значений. */
export type FleetKeysList = { type: "fleetkeys.list"; id: string; v?: 1; to: ".fleetkeys" };
export type FleetKeysListResult = { keys: Record<string, KeyConfig> };

/** fleetkeys.set: человек. Значение ключа — value: поле key кадра занято пропуском. Без value — прежнее; новому ключу value обязателен. */
export type FleetKeysSet = { type: "fleetkeys.set"; id: string; v?: 1; to: ".fleetkeys"; name: string; env: Record<string, string>; settings?: Record<string, unknown>; value?: string };

/** fleetkeys.remove: человек. Ключа нет — no_key. */
export type FleetKeysRemove = { type: "fleetkeys.remove"; id: string; v?: 1; to: ".fleetkeys"; name: string };

/** fleetkeys.key: только пропуск машины. Ключа нет — no_key. */
export type FleetKeysKey = { type: "fleetkeys.key"; id: string; v?: 1; to: ".fleetkeys"; name: string };
export type FleetKeysKeyResult = KeyConfig & { key: string };

/** Кадр без ответа каждой машине после set и remove: система с папкой этого ключа читает его заново. */
export type FleetKeysChanged = { type: "fleetkeys.changed"; v: 1; to: `@${string}`; from: ".fleetkeys"; name: string };

/** Слова отказа: bad_frame — поля не того вида; not_user — set и remove не от человека; not_machine — key не от машины; no_key — ключа нет. */
export type FleetKeysWord = "bad_frame" | "not_user" | "not_machine" | "no_key";
