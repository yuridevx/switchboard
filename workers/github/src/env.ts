import type { GateApi } from "@switchboard/gate";
import type { App } from "./app.ts";

export interface Env {
  /** записи модуля — база D1 модуля во флоте */
  DB: D1Database;
  /** gate: пропуск прямого запроса */
  GATE: GateApi;
  /** объект приложения GitHub, один на флот */
  APP: DurableObjectNamespace<App>;
}
