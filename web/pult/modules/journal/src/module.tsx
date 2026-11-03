// pult-journal — журнал флота. Здесь — только связка с ядром; записи — на экране, приход roster — в store.
import type { AppModule } from "@switchboard/web-core";
import { JournalCtx } from "./context.ts";
import css from "./journal.css";
import { JournalScreen } from "./JournalScreen.tsx";
import { createJournalStore } from "./store.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createJournal(): AppModule {
  const journal = createJournalStore();
  return {
    on: { roster: journal.onRoster },
    screens: {
      journal: {
        nav: "Журнал",
        group: "Флот",
        label: "Журнал флота",
        view: () => (
          <JournalCtx.Provider value={journal}>
            <JournalScreen />
          </JournalCtx.Provider>
        ),
        head: () => ({ title: "Журнал флота" }),
      },
    },
    css,
    start: journal.start,
  };
}
