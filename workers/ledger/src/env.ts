// Привязки Worker'а ledger: база записей и gate для прямого входа.
import type { GateApi } from "@switchboard/gate";

export type Env = { DB: D1Database; GATE: GateApi };
