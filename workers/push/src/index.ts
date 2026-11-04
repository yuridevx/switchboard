// Вход Worker'а push: POST кадра с пропуском (fetch — обёртка entrance) и frame(кадр) по привязке внутри аккаунта.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import type { Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";
import { handle } from "./handle.ts";

export class Participant extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  frame(f: Frame): Promise<Frame[]> {
    return handle(this.env, f);
  }
}

export default Participant;
