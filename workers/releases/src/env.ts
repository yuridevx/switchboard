import type { GateApi } from "@switchboard/gate";
export type Env = { DB: D1Database; BUCKET: R2Bucket; GATE: GateApi; RELAY: { deliver(f: unknown): Promise<number> }; LEDGER: { frame(f: unknown): Promise<unknown> }; CF_ACCOUNT_ID: string; FLEET: string; CLOUDFLARE_API_TOKEN: string; R2_LINK_KEY_ID: string; R2_LINK_SECRET: string };
