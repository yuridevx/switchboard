import type { GateApi } from "@switchboard/gate";
import type { Frame } from "@switchboard/protocol";

export interface Env {
  DB: D1Database;
  GATE: Pick<GateApi, "list" | "redeem">;
  RELAY: { deliver(f: Frame): Promise<number> };
  TELEGRAM_BOT_TOKEN: string;
}
