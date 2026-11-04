// Состояние новой сессии вне экрана: свои последние места у почты; машины и сессии — из roster. Форма живёт на экране.
import type { App, SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { personal, type Personal, useModule, machinesWith } from "@switchboard/web-ui";
import type { Place } from "./form.ts";

/** Сколько своих последних мест хранится. */
const RECENT = 5;

export type OpenStore = ReturnType<typeof createOpenStore>;
/** Стор модуля в экранах. */
export const useOpen = (): OpenStore => useModule<OpenStore>();

export function createOpenStore(app: App) {
  const p: Personal = personal(app, "pult-open", () => app.changed());

  const sessions = (): SessionRecord[] => app.roster()?.sessions ?? [];
  const machineUse = (m: string) => sessions().filter((s) => machineOf(s.callsign) === m).length;

  return {
    stop: p.stop,
    onLink: p.onLink,
    sessions,
    /** Машины, на которых можно открыть сессию. */
    machines: () => machinesWith(app, "session.open"),
    /** Машины по числу сессий: больше — раньше. */
    byUse: (list: string[]) => [...list].sort((a, b) => machineUse(b) - machineUse(a) || a.localeCompare(b)),
    can: (m: string, n: string) => app.can(m, n) === true,
    recents: () => p.get<Place[]>("recent") ?? [],
    /** Первый ответ о своих местах есть (или спросить его не у кого). */
    known: () => p.ready() || app.link() !== "open",
    remember(place: Place) {
      p.edit<Place[]>("recent", (old) => [place, ...(old ?? []).filter((x) => x.m !== place.m || x.dir !== place.dir)].slice(0, RECENT));
    },
  };
}
