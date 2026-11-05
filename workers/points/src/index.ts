// Вход Worker'а points: POST кадра с пропуском, кадр по привязке и уборка расписанием.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import type { Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";
import { frame, sweep } from "./registry.ts";

export default class Points extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  frame(f: Frame): Promise<Frame[]> {
    return frame(this.env, f);
  }

  scheduled(): Promise<void> {
    return sweep(this.env);
  }
}
