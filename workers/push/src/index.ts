// Вход участника рации push: relay зовёт hello() при старте объекта флота и frame(кадр) для кадров с to: ".push".
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";
import type { Env, ParticipantHello } from "./env.ts";
import { log } from "./log.ts";

export { Subs } from "./subs.ts";

export class Participant extends WorkerEntrypoint<Env> {
  hello(): ParticipantHello {
    return { contract: { ...CONTRACT } };
  }

  /** Всё — в один объект флота; ответы push шлёт сам через свою привязку RELAY. Исключение — relay ответит offline. */
  async frame(f: Frame): Promise<void> {
    let out: Frame[];
    try {
      out = (await this.env.SUBS.get(this.env.SUBS.idFromName("home")).frame(f)) as Frame[];
    } catch (e) {
      log({ kind: "stop", ev: f.type, from: f.from, why: String(e) });
      throw e;
    }
    for (const o of out) {
      const word = await this.env.RELAY.frame(o);
      if (word) log({ kind: "refuse", ev: "relay", word, to: o.to, type: o.type, why: "relay не принял кадр push" });
    }
  }
}

export default Participant;
