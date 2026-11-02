// Вход участника рации ledger: relay зовёт hello() при старте объекта флота и frame(кадр) для кадров с to: ".ledger" и roster (у ledger roster@relay в uses).
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import type { Participant as Entry, ParticipantHello } from "@switchboard/relay";
import { CONTRACT, USES } from "../contract.ts";
import type { Env } from "./env.ts";

export { Journal } from "./journal.ts";

export class Participant extends WorkerEntrypoint<Env> implements Entry {
  hello(): ParticipantHello {
    return { contract: { ...CONTRACT }, uses: { ...USES } };
  }

  /** Всё — в один объект флота; его кадры (ответы и события) relay доставит от имени ledger. Исключение — relay ответит offline. */
  async frame(f: Frame): Promise<Frame[]> {
    return (await this.env.JOURNAL.get(this.env.JOURNAL.idFromName("home")).frame(f)) as Frame[];
  }
}

export default Participant;
