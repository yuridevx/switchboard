// web-alerts — уведомления: полоса «Включить уведомления» и пуши, сохранённые обработчиком. Ключ VAPID и подписка — у Worker push;
// машинам приложение подписку не шлёт и у себя её не хранит. Здесь — только связка с ядром; состояние — store.ts.
import type { AppModule } from "@switchboard/web-core";
import css from "./alerts.css";
import { AlertsBar } from "./AlertsBar.tsx";
import { AlertsCtx } from "./context.ts";
import { createAlertsStore, type BrowserPush } from "./store.ts";

/** Новый модуль; browser — API пушей браузера (по умолчанию глобальные). */
export function createAlerts(browser?: BrowserPush): AppModule {
  const alerts = createAlertsStore(browser);
  return {
    screens: {
      alerts: {
        place: "top",
        label: "Уведомления",
        view: () => (
          <AlertsCtx.Provider value={alerts}>
            <AlertsBar />
          </AlertsCtx.Provider>
        ),
      },
    },
    // состояние уведомлений этого устройства — для «Настроек»: off (браузер не умеет), ask, working, on, denied, error
    marks: { "alerts.state": alerts.state },
    store: ["pushes"],
    css,
    start: alerts.start,
  };
}
