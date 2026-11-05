// Снесено: новый код — следующим коммитом.
import type { SessionState } from "../contract.ts";
export type CoreRecord = { callsign: string; session_id: string; cwd: string; sdk: string; stopped: boolean; fork?: string; state?: SessionState; from?: string };
