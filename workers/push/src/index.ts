// Вход участника рации push: relay зовёт hello() при старте объекта флота и frame(кадр) для кадров с to: ".push".
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import type { Participant as Entry, ParticipantHello } from "@switchboard/relay";
import { CONTRACT } from "../contract.ts";
import type { Env } from "./env.ts";

export { Subs } from "./subs.ts";

export class Participant extends WorkerEntrypoint<Env> implements Entry {
  hello(): ParticipantHello {
    return { contract: { ...CONTRACT } };
  }

  /** Всё — в один объект флота; его кадры (ответы и события) relay доставит от имени push. Исключение — relay ответит offline. */
  async frame(f: Frame): Promise<Frame[]> {
    return (await this.env.SUBS.get(this.env.SUBS.idFromName("home")).frame(f)) as Frame[];
  }
}

export default Participant;
