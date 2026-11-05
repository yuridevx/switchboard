// Вход Worker'а points: кадр по привязке, POST кадра с пропуском, уборка по расписанию. Состояния нет: всё в D1 и R2.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import type { Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";
import { answer, sweep } from "./registry.ts";

export class Participant extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  frame(f: Frame): Promise<Frame[]> {
    return answer(this.env, f);
  }

  scheduled(): Promise<void> {
    return sweep(this.env);
  }
}

export default Participant;
