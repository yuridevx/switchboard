// Вход Worker'а points: POST кадра с пропуском (fetch — обёртка entrance), frame(кадр) по привязке внутри аккаунта
// и уборка по расписанию раз в сутки.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import type { Env } from "./env.ts";
import { frame, sweep } from "./registry.ts";

export class Participant extends WorkerEntrypoint<Env> {
  /** Прямой вход: POST кадра с пропуском — тот же frame. */
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  /** Реестр — в базе D1 точек; ответ — кадры вызывающему. */
  frame(f: Frame): Promise<Frame[]> {
    return frame(this.env, f);
  }

  /** Уборка раз в сутки: правило хранения и блоки без ссылок. */
  async scheduled(): Promise<void> {
    await sweep(this.env);
  }
}

export default Participant;
