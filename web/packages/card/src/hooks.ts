// Стор модуля в экранах и общие выборки из roster.
import type { SessionRecord } from "@switchboard/web-core";
import { sessionOf, useApp, useModule } from "@switchboard/web-ui";
import { NAMES, type Can } from "./session.ts";
import type { CardStore } from "./store.ts";

export const useCard = (): CardStore => useModule<CardStore>();

/** Что умеет машина — по contract из roster; кнопка перерисуется, когда он изменился. */
export function useCan(machine: string): Can {
  const app = useApp();
  const on = app.use(() => NAMES.filter((n) => app.can(machine, n) === true));
  return (name) => on.includes(name);
}

/** Запись сессии из roster. */
export function useSession(callsign: string): SessionRecord | undefined {
  const app = useApp();
  return app.use(() => sessionOf(app, callsign));
}
