// pult-points — точки сессий с пометкой «в R2»: обзор реестра, вкладка «Точки» карточки, перенос, копия, смена папки, откат и «пожар».
// Здесь — только связка с ядром: состояние — store.ts, экраны — OverviewScreen и SessionPointsScreen.
import type { App, AppModule } from "@switchboard/web-core";
import { OverviewScreen } from "./OverviewScreen.tsx";
import css from "./points.css";
import { SessionPointsScreen } from "./SessionPointsScreen.tsx";
import { createPointsStore } from "./store.ts";

/** Функция модуля; экран session.points — вкладка «Точки» в месте card.tab карточки. */
export function createPoints(app: App): AppModule {
  const points = createPointsStore(app);
  return {
    state: points,
    screens: {
      points: {
        nav: "Точки",
        group: "Флот",
        label: "Точки",
        view: OverviewScreen,
        head: () => ({ title: "Точки" }),
      },
      "session.points": {
        place: "card.tab",
        label: "Точки",
        path: "session-points",
        // вкладка видна, когда машина сессии умеет точки
        show: (p) => points.canTab(p.callsign ?? ""),
        view: SessionPointsScreen,
      },
    },
    marks: { fire: () => points.fireCount() },
    css,
  };
}
