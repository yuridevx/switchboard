// Снесено: экран отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./inbox.css";

export function createInbox(_app: App): AppModule {
  return { screens: { inbox: { nav: "снесено", path: "inbox", view: () => "снесено" } }, marks: { you: () => 0 }, css };
}
