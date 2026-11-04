// Вход Worker'а ledger: POST кадра с пропуском и frame(кадр) по привязке внутри аккаунта. Состояния нет: записи — в базе D1 модуля.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import type { Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";
import { answer } from "./frames.ts";

export class Participant extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  frame(f: Frame): Promise<Frame[]> {
    return answer(this.env.DB, f);
  }
}

export default Participant;
