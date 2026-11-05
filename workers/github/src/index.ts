// Вход Worker'а github: POST кадра с пропуском (обёртка entrance) и кадр по привязке внутри аккаунта.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import type { Env } from "./env.ts";
import { serve } from "./serve.ts";

export class Participant extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  frame(f: Frame): Promise<Frame[]> {
    return serve(this.env, f);
  }
}

export default Participant;
