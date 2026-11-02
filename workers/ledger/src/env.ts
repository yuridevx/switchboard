import type { GateApi } from "@switchboard/gate";
import type { Journal } from "./journal.ts";

export interface Env {
  /** записи модуля — база D1 модуля во флоте */
  DB: D1Database;
  /** gate: пропуск прямого запроса */
  GATE: GateApi;
  /** объект журнала, один на флот */
  JOURNAL: DurableObjectNamespace<Journal>;
}
