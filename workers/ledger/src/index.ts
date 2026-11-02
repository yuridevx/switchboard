// Вход участника рации ledger: relay зовёт hello() при старте объекта флота и frame(кадр) для кадров с to: ".ledger"; вход и уход машины — ledger.add от relay.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import type { Participant as Entry, ParticipantHello } from "@switchboard/relay";
import { CONTRACT } from "../contract.ts";
import type { Env } from "./env.ts";

export { Journal } from "./journal.ts";

export class Participant extends WorkerEntrypoint<Env> implements Entry {
  /** Прямой вход: POST кадра с пропуском — тот же frame. */
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  hello(): ParticipantHello {
    return { contract: { ...CONTRACT } };
  }

  /** Всё — в один объект флота; его кадры (ответы и события) relay доставит от имени ledger. Исключение — relay ответит offline. */
  async frame(f: Frame): Promise<Frame[]> {
    return (await this.env.JOURNAL.get(this.env.JOURNAL.idFromName("home")).frame(f)) as Frame[];
  }
}

export default Participant;
