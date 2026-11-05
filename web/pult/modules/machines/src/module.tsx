// Снесено: экран отказывает словом, метки пусты.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./machines.css";

export function createMachines(_app: App): AppModule {
  return {
    commands: { "machines.left.read": { run: () => {} } },
    screens: { machines: { nav: "снесено", group: "Флот", view: () => "снесено" } },
    marks: { "machines.gone": () => ({}), "machines.left": () => undefined },
    css,
  };
}
