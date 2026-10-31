import type { Frame } from "@switchboard/protocol";
import type { App } from "./app.ts";

/** Вход Radio relay (контракт frame@relay): свой кадр или reply; ответ — слово отказа или ничего. */
export type Radio = { frame(f: Frame): Promise<string | undefined> };

/** Ответ участника на hello(): контракт и, если нужен roster, uses. */
export type ParticipantHello = { contract: Record<string, number>; uses?: Record<string, number> };

export interface Env {
  /** своя привязка к relay: вход Radio, props { name: "github" } */
  RELAY: Radio;
  /** объект приложения GitHub, один на флот */
  APP: DurableObjectNamespace<App>;
}
