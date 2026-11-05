// pult-points — только связка экранов с ядром: обзор, вкладка карточки, метка «пожара».
import type { App } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { Overview } from "./Overview.tsx";
import css from "./points.css";
import { pointsStore } from "./store.ts";
import { Tab } from "./Tab.tsx";

export function createPoints(app: App): AppModule {
  const store = pointsStore(app);
  return {
    state: store,
    on: { roster: store.roster },
    screens: {
      points: { nav: "Точки", group: "Флот", label: "Точки", view: Overview, head: () => ({ title: "Точки" }) },
      "session.points": {
        place: "card.tab",
        path: "session-points",
        label: "Точки",
        show: (p) => app.can(machineOf(p.callsign ?? "") ?? "", "session.r2") === true,
        view: Tab,
      },
    },
    marks: { fire: store.fire },
    css,
  };
}
