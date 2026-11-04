// web-alerts — уведомления: полоса «Включить уведомления» и пуши, сохранённые обработчиком. Ключ VAPID и подписка — у Worker push;
// машинам приложение подписку не шлёт и у себя её не хранит. Здесь — только связка с ядром; состояние — store.ts.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./alerts.css";
import { AlertsBar } from "./AlertsBar.tsx";
import { createAlertsStore, type BrowserPush } from "./store.ts";

/** Функция модуля; browser — API пушей браузера (по умолчанию глобальные). */
export const createAlerts = (browser?: BrowserPush) => (app: App): AppModule => {
  const alerts = createAlertsStore(app, browser);
  return {
    state: alerts,
    on: { show: alerts.show },
    screens: {
      alerts: {
        place: "top",
        label: "Уведомления",
        view: AlertsBar,
      },
    },
    // состояние уведомлений этого устройства — для «Настроек»: off (браузер не умеет), ask, working, on, denied, error
    marks: { "alerts.state": alerts.state },
    store: ["pushes"],
    css,
    start: alerts.start,
  };
};
