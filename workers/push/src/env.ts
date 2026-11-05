// Привязки и настройки Worker'а push.
import type { GateApi } from "@switchboard/gate";

export type Env = {
  /** закрытый ключ VAPID, JWK: секрет */
  VAPID_PRIVATE: string;
  /** адрес хозяина приложения в подписи VAPID */
  VAPID_SUB: string;
  DB: D1Database;
  GATE: GateApi;
};
