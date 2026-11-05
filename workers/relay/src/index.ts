// Worker relay снесён: вход отказывает словом.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Fleet extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("снесено", { status: 503 });
  }
}
export class Relay extends WorkerEntrypoint {
  async deliver(): Promise<number> {
    throw new Error("снесено");
  }
}
export default { fetch: async () => new Response("снесено", { status: 503 }) };
