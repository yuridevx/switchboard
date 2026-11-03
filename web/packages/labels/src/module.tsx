// web-labels — человеческие имена сессий и машин. Имя заменяет адрес в интерфейсе: метки label.session и label.machine;
// адрес в протоколе, журнале и у агентов не меняется. Здесь — только связка с ядром; имена — store.ts.
import type { AppModule, ScreenProps } from "@switchboard/web-core";
import { LabelsCtx } from "./context.ts";
import css from "./labels.css";
import { LabelsScreen } from "./LabelsScreen.tsx";
import { createLabelsStore } from "./store.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createLabels(): AppModule {
  const labels = createLabelsStore();
  return {
    on: { link: labels.onLink },
    screens: {
      labels: {
        label: "Имена",
        path: "labels",
        view: (p: ScreenProps) => (
          <LabelsCtx.Provider value={labels}>
            <LabelsScreen {...p} />
          </LabelsCtx.Provider>
        ),
      },
    },
    marks: { "label.session": labels.session, "label.machine": labels.machine },
    css,
    start: labels.start,
    stop: labels.settled,
  };
}
