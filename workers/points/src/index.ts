// Снесено: вход контракта отвечает отказом словом, новое письмо — следующим коммитом.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import { fail, type Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";

export class Participant extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  async frame(f: Frame): Promise<Frame[]> {
    return f.id ? [{ ...fail(f.id, "снесено"), to: f.from ?? "" }] : [];
  }

  async scheduled(): Promise<void> {}
}

export default Participant;
