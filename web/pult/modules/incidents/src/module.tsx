// pult-incidents: инциденты флота. Здесь — связка с ядром.
import type { App, AppModule } from "@switchboard/web-core";
import { incidentOf, lamp } from "@switchboard/web-ui";
import css from "./incidents.css";
import { IncidentsScreen } from "./IncidentsScreen.tsx";
import { createStore } from "./store.ts";

export function createIncidents(app: App): AppModule {
  const store = createStore(app);
  return {
    state: store,
    on: { roster: store.onRoster, link: store.onLink },
    marks: { "incidents.open": store.openCount },
    screens: {
      incidents: {
        nav: "Инциденты",
        narrowGroup: "Флот",
        mark: "incidents.open",
        label: "Инциденты",
        view: IncidentsScreen,
        head: () => ({ title: "Инциденты" }),
        find(q) {
          const needle = q.trim().toLowerCase();
          return store.sessions().flatMap((s) => {
            const { type = "", key = "" } = incidentOf(s) ?? {};
            if (!`${type} ${key} ${s.callsign}`.toLowerCase().includes(needle)) return [];
            return [{ label: `${type} · ${s.callsign}`, hint: "инцидент", dot: lamp(s), screen: "incidents" }];
          });
        },
      },
    },
    css,
  };
}
