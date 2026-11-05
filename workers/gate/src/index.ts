// снесено
import { WorkerEntrypoint } from "cloudflare:workers";
export class Gate extends WorkerEntrypoint {
  verify(): never {
    throw new Error("снесено");
  }
}
export default { fetch: async (_req: Request, _env: unknown) => new Response("снесено", { status: 501 }) };
