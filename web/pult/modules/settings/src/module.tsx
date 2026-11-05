// Снесено: вход контракта отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./settings.css";

export function createSettings(_app: App): AppModule {
  return {
    css,
    screens: { "settings": { label: "снесено", view: () => <div>снесено</div> } },
    marks: { "keeper.answers": () => { throw new Error("снесено"); } },
    commands: { "keeper.reload": { run: () => { throw new Error("снесено"); } }, "keeper.open": { run: () => { throw new Error("снесено"); } }, "keeper.close": { run: () => { throw new Error("снесено"); } } },
  };
}
