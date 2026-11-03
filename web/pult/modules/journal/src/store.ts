// Состояние журнала: сколько roster пришло. Каждый — повод дочитать записи, даже с тем же содержимым; записи живут только на экране.
import type { App } from "@switchboard/web-core";
import { createStore } from "@switchboard/web-ui";

export type JournalStore = ReturnType<typeof createJournalStore>;

export function createJournalStore() {
  let app: App;
  const store = createStore({ rosters: 0 }, () => app.changed());
  return {
    start(a: App) {
      app = a;
    },
    onRoster: () => store.set((s) => void s.rosters++),
    rosters: () => store.get().rosters,
  };
}
