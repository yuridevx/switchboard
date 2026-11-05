// Снесено: «Выпуски» пишутся заново.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";

export class Participant extends WorkerEntrypoint {
  async frame(f: Frame): Promise<Frame[]> {
    return [{ type: "reply", id: f.id, ok: false, error: "снесено", to: f.from }];
  }
  async fetch(): Promise<Response> {
    return new Response("снесено", { status: 503 });
  }
}
export default Participant;
