// Снесено: экран отказывает словом, метки пусты.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./board.css";

export function createBoard(_app: App): AppModule {
  return {
    screens: { board: { nav: "снесено", path: "sessions", view: () => "снесено" } },
    commands: {
      "board.assign": { place: "open.after", label: "снесено", show: () => false, run: () => {} },
      "board.pin": { place: "card.menu", label: "снесено", show: () => false, run: () => {} },
      "board.unpin": { place: "card.menu", label: "снесено", show: () => false, run: () => {} },
    },
    marks: { mine: () => "", "project.machines": () => [], "project.current": () => null, "project.of": () => null },
    css,
  };
}
