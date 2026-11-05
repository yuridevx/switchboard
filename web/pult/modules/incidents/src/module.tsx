// Снесено: экрана нет.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./incidents.css";

export const createIncidents = (_app: App): AppModule => ({ css, marks: { "incidents.open": () => 0 } });
