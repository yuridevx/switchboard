// Снесено: вход отвечает отказом словом.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Fleet extends DurableObject {}

export class Relay extends WorkerEntrypoint {
  async deliver(): Promise<number> {
    throw new Error("снесено");
  }
}

export default { fetch: () => new Response("снесено\n", { status: 501 }) };
