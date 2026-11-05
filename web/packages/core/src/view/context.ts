// Что вид ядра берёт у ядра: части из контекста и слова связи.
import { createContext, useContext } from "react";
import type { Address } from "../address.ts";
import type { Halt } from "../entry.ts";
import type { FleetLink } from "../fleet-link.ts";
import type { Modules } from "../modules.ts";
import type { Sections } from "../sections.ts";
import type { Snapshot } from "../snapshot.ts";

export type Core = { wide: boolean; brand?: string; win: Window; snap: Snapshot; modules: Modules; sections: Sections; address: Address; link: FleetLink; halt: Halt };

export const CoreCtx = createContext<Core | null>(null);
export const useCore = (): Core => useContext(CoreCtx)!;

/** Связь флота → пилюля. */
export function connPill(conn: string) {
  if (conn === "open") return { text: "на связи", tone: "ok" as const };
  return conn === "closed" ? { text: "нет связи", tone: "bad" as const } : { text: "подключаюсь", tone: "wait" as const };
}
