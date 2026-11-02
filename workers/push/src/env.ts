import type { GateApi } from "@switchboard/gate";
import type { Subs } from "./subs.ts";

export interface Env {
  /** gate: пропуск прямого запроса */
  GATE: GateApi;
  /** закрытый ключ VAPID — JWK P-256; открытую половину push выводит из него */
  VAPID_PRIVATE: string;
  /** sub в JWT VAPID: адрес, по которому служба пушей может связаться с владельцем */
  VAPID_SUB: string;
  /** объект подписок, один на флот */
  SUBS: DurableObjectNamespace<Subs>;
}
