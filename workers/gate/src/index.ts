// Worker gate: вход Gate с одним методом verify. Адреса в интернете нет — только привязка relay.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { GateApi, VerifyResult } from "../contract.ts";
import { verifyKey } from "./key.ts";

export type Env = {
  /** секрет флота: им подписаны все ключи */
  FLEET_SECRET?: string;
  /** номера отозванных ключей role.name.kid */
  REVOKED?: string[];
};

export class Gate extends WorkerEntrypoint<Env> implements GateApi {
  verify(key: string): Promise<VerifyResult> {
    return verifyKey(key, this.env.FLEET_SECRET, this.env.REVOKED ?? [], (line) => console.log(line));
  }
}

// HTTP-входа нет: workers_dev и preview_urls выключены, маршрутов нет.
export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};
