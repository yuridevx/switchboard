import type { GateApi } from "@switchboard/gate";

export interface Env {
  /** настройки пользователей — своя база D1, отдельно от служебных баз флота */
  DB: D1Database;
  /** gate: пропуск прямого запроса */
  GATE: GateApi;
}
