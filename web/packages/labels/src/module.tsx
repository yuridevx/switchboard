// web-labels — человеческие имена сессий и машин. Имя заменяет адрес в интерфейсе; адрес в протоколе, журнале и у агентов не меняется.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./labels.css";
import { LabelsScreen } from "./LabelsScreen.tsx";
import { createNames } from "./names.ts";

export function createLabels(app: App): AppModule {
  const names = createNames(app);
  return {
    state: names,
    on: { link: names.onLink },
    screens: { labels: { label: "Имена", path: "labels", view: LabelsScreen } },
    marks: { "label.session": names.session, "label.machine": names.machine },
    css,
    stop: names.stop,
  };
}
