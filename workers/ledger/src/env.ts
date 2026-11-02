import type { GateApi } from "@switchboard/gate";
import type { Journal } from "./journal.ts";

export interface Env {
  /** gate: пропуск прямого запроса */
  GATE: GateApi;
  /** объект журнала, один на флот */
  JOURNAL: DurableObjectNamespace<Journal>;
}
