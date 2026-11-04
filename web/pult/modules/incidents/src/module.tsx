// Снесено: экран отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./incidents.css";

export function createIncidents(_app: App): AppModule {
  return { screens: { incidents: { nav: "снесено", view: () => "снесено" } }, marks: { "incidents.open": () => 0 }, css };
}
