// Снесено: экран отказывает словом.
import type { AppModule } from "@switchboard/web-core";
import css from "./journal.css";

export function createJournal(): AppModule {
  return { screens: { journal: { nav: "снесено", view: () => "снесено" } }, css };
}
