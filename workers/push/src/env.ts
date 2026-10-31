import type { Frame } from "@switchboard/protocol";
import type { Subs } from "./subs.ts";

/** Вход Radio relay (контракт frame@relay): свой кадр или reply; ответ — слово отказа или ничего. */
export type Radio = { frame(f: Frame): Promise<string | undefined> };

/** Ответ участника на hello(): контракт и, если нужен roster, uses. */
export type ParticipantHello = { contract: Record<string, number>; uses?: Record<string, number> };

export interface Env {
  /** закрытый ключ VAPID — JWK P-256; открытую половину push выводит из него */
  VAPID_PRIVATE: string;
  /** sub в JWT VAPID: адрес, по которому служба пушей может связаться с владельцем */
  VAPID_SUB: string;
  /** своя привязка к relay: вход Radio, props { name: "push" } */
  RELAY: Radio;
  /** объект подписок, один на флот */
  SUBS: DurableObjectNamespace<Subs>;
}
