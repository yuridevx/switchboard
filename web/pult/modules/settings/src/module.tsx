// Снесено: экран отказывает словом, ответов нет.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./settings.css";

export function createSettings(_app: App): AppModule {
  return {
    commands: { "keeper.open": { run: () => {} }, "keeper.close": { run: () => {} }, "keeper.reload": { run: () => {} } },
    screens: { settings: { nav: "снесено", group: "Флот", view: () => "снесено" } },
    marks: { "keeper.answers": () => ({}) },
    css,
  };
}
