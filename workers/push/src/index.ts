// снесено
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";

export class Participant extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return new Response("снесено", { status: 503 });
  }

  async frame(f: Frame): Promise<Frame[]> {
    return f.id ? [{ type: "reply", id: f.id, ok: false, error: "снесено", to: f.from }] : [];
  }
}

export default Participant;
