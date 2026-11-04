// Снесено: вход контракта отказывает словом.
import { WorkerEntrypoint } from "cloudflare:workers";
import { fail, type Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";

export class Participant extends WorkerEntrypoint<Env> {
  fetch(): Response {
    return new Response(null, { status: 503 });
  }
  async frame(f: Frame): Promise<Frame[]> {
    return f.id ? [{ ...fail(f.id, "demolished"), to: f.from ?? "" }] : [];
  }
}

export default Participant;
