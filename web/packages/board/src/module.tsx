// Снесено: вход контракта отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./board.css";

export function createBoard(_app: App): AppModule {
  return {
    css,
    screens: { "board": { label: "снесено", view: () => <div>снесено</div> } },
    marks: { "mine": () => { throw new Error("снесено"); }, "project.machines": () => { throw new Error("снесено"); }, "project.current": () => { throw new Error("снесено"); }, "project.of": () => { throw new Error("снесено"); } },
    commands: { "board.assign": { run: () => { throw new Error("снесено"); } }, "board.pin": { run: () => { throw new Error("снесено"); } }, "board.unpin": { run: () => { throw new Error("снесено"); } } },
  };
}
