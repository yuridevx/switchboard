// Снесено: вход Worker'а отказывает словом, пока не написан заново.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { GateApi, Pass, VerifyResult } from "../contract.ts";

export type Env = { DB: D1Database };

export class Gate extends WorkerEntrypoint<Env> implements GateApi {
  async verify(): Promise<VerifyResult> {
    return { error: "снесено" as "bad_key" };
  }
  async revoke(): Promise<{ addr: string } | { error: "unknown_key" }> {
    return { error: "снесено" as "unknown_key" };
  }
  async revoked(): Promise<string[]> {
    return ["снесено"];
  }
  async list(): Promise<Pass[]> {
    return [];
  }
}

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return Response.json({ type: "reply", id: "", ok: false, error: "снесено" }, { status: 500 });
  },
};
