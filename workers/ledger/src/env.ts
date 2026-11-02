import type { Journal } from "./journal.ts";

export interface Env {
  /** объект журнала, один на флот */
  JOURNAL: DurableObjectNamespace<Journal>;
}
