// pult-points — точки сессий с пометкой «в R2»: обзор реестра, вкладка «Точки» карточки, перенос, копия, смена папки, откат и «пожар».
// Здесь — только связка с ядром: состояние — store.ts, экраны — OverviewScreen и SessionPointsScreen.
import type { AppModule, ScreenProps } from "@switchboard/web-core";
import { PointsCtx } from "./context.ts";
import { OverviewScreen } from "./OverviewScreen.tsx";
import css from "./points.css";
import { SessionPointsScreen } from "./SessionPointsScreen.tsx";
import { createPointsStore } from "./store.ts";

/** Новый модуль со своей памятью; экран session.points — вкладка «Точки» в месте card.tab карточки. */
export function createPoints(): AppModule {
  const points = createPointsStore();
  return {
    screens: {
      points: {
        nav: "Точки",
        group: "Флот",
        label: "Точки",
        view: () => (
          <PointsCtx.Provider value={points}>
            <OverviewScreen />
          </PointsCtx.Provider>
        ),
        head: () => ({ title: "Точки" }),
      },
      "session.points": {
        place: "card.tab",
        label: "Точки",
        path: "session-points",
        // вкладка видна, когда машина сессии умеет точки
        show: (p) => points.canTab(p.callsign ?? ""),
        view: (props: ScreenProps) => (
          <PointsCtx.Provider value={points}>
            <SessionPointsScreen {...props} />
          </PointsCtx.Provider>
        ),
      },
    },
    marks: { fire: () => points.fireCount() },
    css,
    start: points.start,
  };
}
