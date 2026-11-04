// pult-points: связка с приложением. Состояние — store.ts, экраны — OverviewScreen и SessionPointsScreen.
import type { App, AppModule } from "@switchboard/web-core";
import { OverviewScreen } from "./OverviewScreen.tsx";
import css from "./points.css";
import { SessionPointsScreen } from "./SessionPointsScreen.tsx";
import { createPointsStore } from "./store.ts";

export function createPoints(app: App): AppModule {
  const points = createPointsStore(app);
  return {
    state: points,
    on: { roster: points.onRoster },
    screens: {
      points: { nav: "Точки", group: "Флот", label: "Точки", view: OverviewScreen, head: () => ({ title: "Точки" }) },
      // вкладка карточки: видна, когда машина сессии умеет точки
      "session.points": { place: "card.tab", label: "Точки", path: "session-points", show: (p) => points.tabVisible(p.callsign ?? ""), view: SessionPointsScreen },
    },
    marks: { fire: points.lostMachines },
    css,
  };
}
