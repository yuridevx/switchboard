import type { GateApi } from "@switchboard/gate";

export interface Env {
  DB: D1Database;
  GATE: GateApi;
  VAPID_PRIVATE: string;
  VAPID_SUB: string;
}
