// Полоса «Включить уведомления» над экранами разделов; включены или браузер не умеет — полосы нет.
import { useApp } from "@switchboard/web-ui";
import { useAlerts } from "./store.ts";

export function AlertsBar() {
  const app = useApp();
  const alerts = useAlerts();
  const state = app.use(alerts.state);
  const error = app.use(alerts.error);
  if (state === "off" || state === "on") return null;
  if (state === "denied") {
    return (
      <div className="al-card muted">
        <span>
          <b>Уведомления запрещены</b>
          <span>Разрешите их в настройках браузера для этого сайта.</span>
        </span>
      </div>
    );
  }
  return (
    <div className="al-card">
      <span>
        <b>Включить уведомления</b>
        {state === "error" ? <span>{`Не вышло: ${error}`}</span> : null}
      </span>
      <button className="al-on" disabled={state === "working"} onClick={() => void alerts.enable()}>
        {state === "working" ? "…" : state === "error" ? "Ещё раз" : "Включить"}
      </button>
    </div>
  );
}
