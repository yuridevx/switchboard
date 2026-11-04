// Контракт web-alerts — уведомления (общий пакет телефона и пульта).
// Модуль приложения: полоса alerts над экранами разделов — «Включить уведомления»:
// разрешение по нажатию → push.key (Worker push) → подписка браузера этим ключом → push.subscribe.
// Метка alerts.state — состояние уведомлений устройства (off, ask, working, on, denied, error).
// Раздел pushes: пуши, сохранённые обработчиком; при старте и возвращении на экран — app.deliver владельцу.
// Обработчик пушей — serviceWorker(self, { relayUrl, store, maxActions }) в sw.js приложения:
// показ notify, кнопки (если все помещаются), короткое wss для кнопки, открытие приложения по нажатию.
import type { AppPart, Manifest } from "@switchboard/web-core";
import type { AlertsState } from "./src/module.tsx";
import json from "./module.json" with { type: "json" };
import { createAlerts } from "./src/module.tsx";

declare module "@switchboard/web-ui" {
  interface Marks {
    "alerts.state"(): AlertsState;
  }
}

export { createAlerts } from "./src/module.tsx";
export type { BrowserPush } from "./src/module.tsx";
export { serviceWorker } from "./src/sw.ts";
export type { SwScope } from "./src/sw.ts";
export const manifest: Manifest = json;
export default createAlerts() satisfies AppPart["module"];
