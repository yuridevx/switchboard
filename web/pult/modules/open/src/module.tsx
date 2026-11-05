// Снесено: экран отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./open.css";

export function createOpen(_app: App): AppModule {
  return { screens: { open: { label: "снесено", view: () => "снесено" } }, css };
}
