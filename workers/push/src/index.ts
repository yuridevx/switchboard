// Вход Worker'а push: POST кадра с пропуском (fetch — обёртка entrance) и frame(кадр) по привязке внутри аккаунта.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import type { Env } from "./env.ts";
import { frame } from "./subs.ts";

export class Participant extends WorkerEntrypoint<Env> {
  /** Прямой вход: POST кадра с пропуском — тот же frame. */
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  /** Подписки — в базе D1 push; ответ — кадры вызывающему. */
  frame(f: Frame): Promise<Frame[]> {
    return frame(this.env, f);
  }
}

export default Participant;
