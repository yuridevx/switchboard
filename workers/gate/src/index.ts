// Снесено: заглушка Worker'а, реализация пишется заново.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Gate extends WorkerEntrypoint<{ DB: D1Database }> {
  verify(): never {
    throw new Error("снесено");
  }
  revoke(): never {
    throw new Error("снесено");
  }
  revoked(): never {
    throw new Error("снесено");
  }
  list(): never {
    throw new Error("снесено");
  }
}

export default { fetch: (_req: Request, _env: { DB: D1Database }) => new Response("снесено", { status: 500 }) };
