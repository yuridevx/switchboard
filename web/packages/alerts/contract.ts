// Контракт web-alerts — уведомления (общий пакет телефона и пульта).
// Модуль приложения: полоса alerts над экранами разделов — «Включить уведомления»:
// разрешение по нажатию → push.key (Worker push) → подписка браузера этим ключом → push.subscribe.
// Раздел pushes: пуши, сохранённые обработчиком; при старте и возвращении на экран — app.deliver владельцу.
// Обработчик пушей — serviceWorker(self, { relayUrl, store, maxActions }) в sw.js приложения:
// показ notify, кнопки (если все помещаются), короткое wss для кнопки, открытие приложения по нажатию.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createAlerts } from "./src/module.ts";

export { createAlerts, b64url } from "./src/module.ts";
export type { BrowserPush } from "./src/module.ts";
export { serviceWorker, sendOnce } from "./src/sw.ts";
export type { Notify, StoredPush, SwScope, SwOptions } from "./src/sw.ts";
export const manifest: Manifest = json;
export default createAlerts() satisfies AppModule;
