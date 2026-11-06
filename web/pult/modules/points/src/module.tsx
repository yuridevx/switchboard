// pult-points: связка экранов точек с ядром страницы.
import { MapPin } from "lucide-react";
import type { App, AppModule } from "@switchboard/web-core";
import css from "./points.css";
import { Overview } from "./Overview.tsx";
import { createFleet } from "./store.ts";
import { Tab } from "./Tab.tsx";

export function createPoints(app: App): AppModule {
  const fleet = createFleet(app);
  return {
    state: fleet,
    on: { roster: fleet.onRoster },
    marks: { fire: fleet.fire },
    screens: {
      points: { nav: "Точки", icon: MapPin, group: "Флот", label: "Точки", view: Overview, head: () => ({ title: "Точки" }) },
      "session.points": {
        place: "card.tab",
        path: "session-points",
        label: "Точки",
        view: Tab,
        show: (p) => app.can(p.callsign?.split("@")[1] ?? "", "session.r2") === true,
        head: (p) => ({ title: `Точки ${p.callsign}` }),
      },
    },
    css,
  };
}
