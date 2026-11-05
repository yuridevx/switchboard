import { WorkerEntrypoint } from "cloudflare:workers";
import { fail, type Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import type { Env } from "./env.ts";
export class Participant extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> { return entrance(req, this.env.GATE, (f) => this.frame(f)); }
  async frame(f: Frame): Promise<Frame[]> { return f.id ? [{ ...fail(f.id, "снесено"), to: f.from }] : []; }
}
export default Participant;
