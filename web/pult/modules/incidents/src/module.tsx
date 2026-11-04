// pult-incidents — инциденты: сессии с полем roster incident и недоставленные обращения. Своего хранилища нет. Здесь — только связка с ядром.
import type { App, AppModule } from "@switchboard/web-core";
import { stateLabel } from "@switchboard/web-ui";
import css from "./incidents.css";
import { IncidentsScreen } from "./IncidentsScreen.tsx";
import { createIncidentsStore, incident } from "./store.ts";

export function createIncidents(app: App): AppModule {
  const store = createIncidentsStore(app);
  return {
    state: store,
    on: { roster: store.onRoster },
    screens: {
      incidents: {
        nav: "Инциденты",
        // телефон: во «Флоте»; пульт — отдельный раздел колонки
        narrowGroup: "Флот",
        mark: "incidents.open",
        label: "Инциденты",
        view: IncidentsScreen,
        head: () => ({ title: "Инциденты" }),
        find: (q) =>
          store
            .sessions()
            .filter((s) => !q || `${incident(s)!.type} ${incident(s)!.key ?? ""} ${s.callsign}`.toLowerCase().includes(q))
            .map((s) => ({ label: `${incident(s)!.type} · ${s.callsign}`, hint: "инцидент", dot: stateLabel(s.state).dot, screen: "incidents", params: {} })),
      },
    },
    marks: { "incidents.open": () => store.openCount() },
    css,
  };
}
