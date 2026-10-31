// Вход участника рации points: relay зовёт hello() при старте объекта флота и frame(кадр) для кадров с to: "points".
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";
import type { Env, ParticipantHello } from "./env.ts";
import { log } from "./log.ts";

export { Registry } from "./registry.ts";

export class Participant extends WorkerEntrypoint<Env> {
  hello(): ParticipantHello {
    return { contract: { ...CONTRACT } };
  }

  /** Всё — в один объект флота; ответы и ledger.add points шлёт сам через свою привязку RELAY. Исключение — relay ответит offline. */
  async frame(f: Frame): Promise<void> {
    let out: Frame[];
    try {
      out = (await this.env.REGISTRY.get(this.env.REGISTRY.idFromName("home")).frame(f)) as Frame[];
    } catch (e) {
      log({ kind: "stop", ev: f.type, from: f.from, why: String(e) });
      throw e;
    }
    for (const o of out) {
      const word = await this.env.RELAY.frame(o);
      if (word) log({ kind: "refuse", ev: "relay", word, to: o.to, type: o.type, why: "relay не принял кадр points" });
    }
  }
}

export default Participant;
