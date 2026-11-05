// Снесено: вход Worker'а github отказывает словом.
import { WorkerEntrypoint } from "cloudflare:workers";
import { fail, type Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";

export class Participant extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return Response.json(fail("", "снесено"), { status: 500 });
  }

  async frame(f: Frame): Promise<Frame[]> {
    return f.id ? [{ ...fail(f.id, "снесено"), to: f.from ?? "" }] : [];
  }
}

export default Participant;
