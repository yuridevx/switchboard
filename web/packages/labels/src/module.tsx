// web-labels — человеческие имена сессий и машин. Имя заменяет адрес в интерфейсе: метки label.session и label.machine;
// адрес в протоколе, журнале и у агентов не меняется. Здесь — только связка с ядром; имена — store.ts.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./labels.css";
import { LabelsScreen } from "./LabelsScreen.tsx";
import { createLabelsStore } from "./store.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createLabels(app: App): AppModule {
  const labels = createLabelsStore(app);
  return {
    state: labels,
    on: { link: labels.onLink },
    screens: {
      labels: {
        label: "Имена",
        path: "labels",
        view: LabelsScreen,
      },
    },
    marks: { "label.session": labels.session, "label.machine": labels.machine },
    css,
    stop: labels.settled,
  };
}
