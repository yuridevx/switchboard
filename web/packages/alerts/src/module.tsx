// web-alerts: связка уведомлений с ядром приложения. Состояние — store.ts, экран — AlertsBar.tsx.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./alerts.css";
import { AlertsBar } from "./AlertsBar.tsx";
import { createAlertsStore, type BrowserPush } from "./store.ts";

/** Функция модуля; browser — API пушей браузера, по умолчанию настоящие. */
export const createAlerts =
  (browser?: BrowserPush) =>
  (app: App): AppModule => {
    const alerts = createAlertsStore(app, browser);
    return {
      state: alerts,
      on: { show: alerts.show },
      screens: { alerts: { place: "top", label: "Уведомления", view: AlertsBar } },
      marks: { "alerts.state": alerts.state },
      store: ["pushes"],
      css,
      start: alerts.start,
    };
  };
