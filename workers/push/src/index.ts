// Вход Worker'а push: POST кадра с пропуском (fetch — обёртка entrance) и frame(кадр) по привязке внутри аккаунта.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import type { Env } from "./env.ts";

export { Subs } from "./subs.ts";

export class Participant extends WorkerEntrypoint<Env> {
  /** Прямой вход: POST кадра с пропуском — тот же frame. */
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  /** Всё — в один объект флота; ответ — кадры вызывающему. */
  async frame(f: Frame): Promise<Frame[]> {
    return (await this.env.SUBS.get(this.env.SUBS.idFromName("home")).frame(f)) as Frame[];
  }
}

export default Participant;
