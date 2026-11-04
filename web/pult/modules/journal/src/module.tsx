// pult-journal — журнал флота. Здесь — только связка с ядром; записи открытого экрана и дочитывание по roster — в store.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./journal.css";
import { JournalScreen } from "./JournalScreen.tsx";
import { createJournalStore } from "./store.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createJournal(app: App): AppModule {
  const journal = createJournalStore(app);
  return {
    state: journal,
    on: { roster: journal.onRoster },
    screens: {
      journal: {
        nav: "Журнал",
        group: "Флот",
        label: "Журнал флота",
        view: JournalScreen,
        head: () => ({ title: "Журнал флота" }),
      },
    },
    css,
  };
}
