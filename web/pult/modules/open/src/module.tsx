// Снесено: вход контракта отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./open.css";

export function createOpen(_app: App): AppModule {
  return {
    css,
    screens: { "open": { label: "снесено", view: () => <div>снесено</div> } },
    marks: {  },
    commands: {  },
  };
}
