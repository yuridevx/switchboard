// Вход Worker'а releases: POST кадра с пропуском (fetch — обёртка entrance) и frame(кадр) по привязке внутри аккаунта.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import type { Env } from "./env.ts";
import { frame } from "./releases.ts";

export class Participant extends WorkerEntrypoint<Env> {
  /** Прямой вход: POST кадра с пропуском — тот же frame. */
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  /** Строка флота — в базе D1 «Выпусков»; ответ — кадры вызывающему. */
  frame(f: Frame): Promise<Frame[]> {
    return frame(this.env, f);
  }
}

export default Participant;
