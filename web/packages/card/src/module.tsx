// Снесено: вход контракта отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./card.css";

export function createCard(_app: App): AppModule {
  return {
    css,
    screens: { "card": { label: "снесено", view: () => <div>снесено</div> } },
    marks: {  },
    commands: { "card.head.reset": { run: () => { throw new Error("снесено"); } } },
  };
}
