import type { GateApi } from "@switchboard/gate";

export interface Env {
  /** журнал: одна таблица events */
  DB: D1Database;
  /** пропуск прямого запроса */
  GATE: GateApi;
}
