// pult-points: «Сессии» — архив флота; страница сессии — и экраном, и вкладкой «Архив» карточки.
import { History } from "lucide-react";
import type { App, AppModule, ScreenProps } from "@switchboard/web-core";
import { List } from "./List.tsx";
import css from "./points.css";
import { CardTab, SessionPage } from "./Session.tsx";
import { createFleet } from "./store.ts";

/** Экран «Сессии»: без sid — список, с sid — страница сессии; point — выбранная точка, uuid и q — найденное место. */
function Sessions({ params }: ScreenProps) {
  if (!params.sid) return <List />;
  return <SessionPage key={params.sid} sid={params.sid} point={params.point ? Number(params.point) : undefined} uuid={params.uuid} q={params.q} pane={params.pane} />;
}

export function createPoints(app: App): AppModule {
  const fleet = createFleet(app);
  return {
    state: fleet,
    on: { roster: fleet.onRoster },
    marks: { fire: fleet.fire },
    screens: {
      points: {
        nav: "Сессии",
        icon: History,
        group: "Флот",
        label: "Сессии",
        view: Sessions,
        head: (p) => ({ title: p.sid ? (fleet.bySid(p.sid)?.title ?? "Сессия") : "Сессии" }),
      },
      "session.points": {
        place: "card.tab",
        path: "session-points",
        label: "Архив",
        view: CardTab,
        show: (p) => app.can(p.callsign?.split("@")[1] ?? "", "session.archive") === true,
        head: (p) => ({ title: `Архив ${p.callsign}` }),
      },
    },
    css,
  };
}
