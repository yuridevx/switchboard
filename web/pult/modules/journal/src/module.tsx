// pult-journal: журнал флота. Здесь — связка с ядром.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./journal.css";
import { JournalScreen } from "./JournalScreen.tsx";

export function createJournal(_app: App): AppModule {
  return {
    screens: { journal: { nav: "Журнал", group: "Флот", label: "Журнал флота", view: JournalScreen, head: () => ({ title: "Журнал флота" }) } },
    css,
  };
}
