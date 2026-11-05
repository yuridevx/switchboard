// Состояние новой сессии вне экрана: свои последние места у почты; машины и сессии — из roster. Форма живёт на экране.
import type { App, SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { machinesWith, personal, useModule } from "@switchboard/web-ui";

export type Place = { m: string; dir: string };

/** Сколько своих последних мест хранится. */
const RECENT = 5;

export type OpenState = ReturnType<typeof createOpenState>;
export const useOpen = (): OpenState => useModule<OpenState>();

export function createOpenState(app: App) {
  const prefs = personal(app, "pult-open", () => app.changed());
  const sessions = (): SessionRecord[] => app.roster()?.sessions ?? [];
  const inUse = (m: string) => sessions().filter((s) => machineOf(s.callsign) === m).length;

  return {
    stop: prefs.stop,
    onLink: prefs.onLink,
    sessions,
    /** Машины, на которых можно открыть сессию. */
    machines: () => machinesWith(app, "session.open"),
    /** Машины по числу сессий: больше — раньше. */
    byUse: (list: string[]) => [...list].sort((a, b) => inUse(b) - inUse(a) || a.localeCompare(b)),
    can: (m: string, n: string) => app.can(m, n) === true,
    recents: () => prefs.get<Place[]>("recent") ?? [],
    /** Первый ответ о своих местах есть (или спросить его не у кого). */
    known: () => prefs.ready() || app.link() !== "open",
    remember(place: Place) {
      prefs.edit<Place[]>("recent", (old) => [place, ...(old ?? []).filter((x) => x.m !== place.m || x.dir !== place.dir)].slice(0, RECENT));
    },
  };
}
