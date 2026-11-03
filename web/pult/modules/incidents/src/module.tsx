// pult-incidents — инциденты: сессии с полем roster incident и недоставленные обращения из журнала машины.
// Своего хранилища нет: сессии — из roster, недоставленные — обращения incident.pending без сессии, причина — из журнала. Здесь — только связка с ядром.
import type { AppModule } from "@switchboard/web-core";
import { stateLabel } from "@switchboard/web-ui";
import { IncidentsCtx } from "./context.ts";
import css from "./incidents.css";
import { IncidentsScreen } from "./IncidentsScreen.tsx";
import { createIncidentsStore, incOf } from "./store.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createIncidents(): AppModule {
  const incidents = createIncidentsStore();
  return {
    on: { roster: incidents.onRoster },
    screens: {
      incidents: {
        nav: "Инциденты",
        // телефон: во «Флоте»; пульт — отдельный раздел колонки
        narrowGroup: "Флот",
        mark: "incidents.open",
        label: "Инциденты",
        view: () => (
          <IncidentsCtx.Provider value={incidents}>
            <IncidentsScreen />
          </IncidentsCtx.Provider>
        ),
        head: () => ({ title: "Инциденты" }),
        find: (q) =>
          incidents
            .sessions()
            .filter((s) => !q || `${incOf(s)!.type} ${incOf(s)!.key ?? ""} ${s.callsign}`.toLowerCase().includes(q))
            .map((s) => ({ label: `${incOf(s)!.type} · ${s.callsign}`, hint: "инцидент", dot: stateLabel(s.state).dot, screen: "incidents", params: {} })),
      },
    },
    marks: { "incidents.open": () => incidents.openCount() },
    css,
    start: incidents.start,
  };
}
