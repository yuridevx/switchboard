// Состояние модуля в контексте его экранов и общие выборки из roster.
import { createContext, useContext } from "react";
import { useApp, type SessionRecord } from "@switchboard/web-core";
import { NAMES, type Can } from "./session.ts";
import type { CardStore } from "./store.ts";

export const CardCtx = createContext<CardStore | null>(null);
export const useCard = (): CardStore => useContext(CardCtx)!;

/** Что умеет машина — по contract из roster; кнопка перерисуется, когда он изменился. */
export function useCan(machine: string): Can {
  const app = useApp();
  const on = app.use(() => NAMES.filter((n) => app.can(machine, n) === true));
  return (name) => on.includes(name);
}

/** Запись сессии из roster. */
export function useSession(callsign: string): SessionRecord | undefined {
  const app = useApp();
  return app.use(() => app.roster()?.sessions.find((s) => s.callsign === callsign));
}
