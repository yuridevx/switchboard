import type { Frame } from "@switchboard/protocol";
import type { Journal } from "./journal.ts";

/** Вход Radio relay (контракт frame@relay): свой кадр или reply; ответ — слово отказа или ничего. */
export type Radio = { frame(f: Frame): Promise<string | undefined> };

/** Ответ участника на hello(): контракт и, если нужен roster, uses. */
export type ParticipantHello = { contract: Record<string, number>; uses?: Record<string, number> };

export interface Env {
  /** своя привязка к relay: вход Radio, props { name: "ledger" } */
  RELAY: Radio;
  /** объект журнала, один на флот */
  JOURNAL: DurableObjectNamespace<Journal>;
}
