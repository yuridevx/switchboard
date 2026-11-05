// Снесено: экран отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./card.css";

export function createCard(_app: App): AppModule {
  return {
    screens: { card: { label: "снесено", view: () => "снесено" }, "card.view": { label: "снесено", path: "card-view", view: () => "снесено" } },
    commands: { "card.head.reset": { run: () => {} } },
    css,
  };
}
