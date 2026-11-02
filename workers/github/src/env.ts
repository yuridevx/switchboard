import type { GateApi } from "@switchboard/gate";
import type { App } from "./app.ts";

export interface Env {
  /** gate: пропуск прямого запроса */
  GATE: GateApi;
  /** объект приложения GitHub, один на флот */
  APP: DurableObjectNamespace<App>;
}
