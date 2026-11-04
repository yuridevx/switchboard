// pult-journal — журнал флота. Здесь — только связка с ядром; записи открытого экрана и дочитывание по roster — в store.
import type { AppModule } from "@switchboard/web-core";
import css from "./journal.css";
import { JournalScreen } from "./JournalScreen.tsx";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createJournal(): AppModule {
  return {
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
