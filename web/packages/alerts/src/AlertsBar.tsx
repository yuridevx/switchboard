// Полоса над экранами разделов: включить уведомления или узнать, что они запрещены. Включены или браузер не умеет — полосы нет.
import { Btn, useApp } from "@switchboard/web-ui";
import { useAlerts } from "./store.ts";

const BUTTON = { working: "…", error: "Ещё раз" } as const;

export function AlertsBar() {
  const app = useApp();
  const alerts = useAlerts();
  const state = app.use(alerts.state);
  const error = app.use(alerts.error);
  switch (state) {
    case "off":
    case "on":
      return null;
    case "denied":
      return (
        <div className="al-card muted">
          <span>
            <b>Уведомления запрещены</b>
            <span>Разрешите их в настройках браузера для этого сайта.</span>
          </span>
        </div>
      );
    default:
      return (
        <div className="al-card">
          <span>
            <b>Включить уведомления</b>
            {state === "error" ? <span>{`Не вышло: ${error}`}</span> : null}
          </span>
          <Btn pri className="al-on" disabled={state === "working"} onClick={() => void alerts.enable()}>
            {state === "ask" ? "Включить" : BUTTON[state]}
          </Btn>
        </div>
      );
  }
}
