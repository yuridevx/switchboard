// pult-journal — журнал флота: только связка экрана с ядром.
import type { AppModule } from "@switchboard/web-core";
import css from "./journal.css";
import { JournalScreen } from "./JournalScreen.tsx";

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
