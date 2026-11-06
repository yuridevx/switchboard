import type { GateApi } from "@switchboard/gate";
import type { RoomsApi } from "@switchboard/rooms";

export interface Env {
  DB: D1Database;
  GATE: GateApi;
  ROOMS: RoomsApi;
  VAPID_PRIVATE: string;
  VAPID_SUB: string;
}
