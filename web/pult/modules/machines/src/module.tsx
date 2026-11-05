// Снесено: вход контракта отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./machines.css";

export function createMachines(_app: App): AppModule {
  return {
    css,
    screens: { "machines": { label: "снесено", view: () => <div>снесено</div> } },
    marks: { "machines.gone": () => { throw new Error("снесено"); }, "machines.left": () => { throw new Error("снесено"); } },
    commands: { "machines.left.read": { run: () => { throw new Error("снесено"); } } },
  };
}
