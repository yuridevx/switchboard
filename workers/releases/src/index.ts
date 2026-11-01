// Вход участника рации releases: relay зовёт hello() при старте объекта флота и frame(кадр) для кадров с to: ".releases".
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";
import type { Env, ParticipantHello } from "./env.ts";
import { log } from "./log.ts";

export { Releases } from "./releases.ts";

export class Participant extends WorkerEntrypoint<Env> {
  hello(): ParticipantHello {
    return { contract: { ...CONTRACT } };
  }

  /** Всё — в один объект выпусков; ответы, планы keeper'ам и ledger.add releases шлёт сам через свою привязку RELAY. */
  async frame(f: Frame): Promise<void> {
    let out: Frame[];
    try {
      out = (await this.env.RELEASES.get(this.env.RELEASES.idFromName("home")).frame(f)) as Frame[];
    } catch (e) {
      log({ kind: "stop", ev: f.type, from: f.from, why: String(e) });
      throw e;
    }
    for (const o of out) {
      const word = await this.env.RELAY.frame(o);
      if (word) log({ kind: "refuse", ev: "relay", word, to: o.to, type: o.type, why: "relay не принял кадр releases" });
    }
  }
}

export default Participant;
