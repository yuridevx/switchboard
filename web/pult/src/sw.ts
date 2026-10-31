// sw.js пульта: служебный обработчик пушей из web-alerts (тот же, что у телефона).
import { serviceWorker, type SwScope } from "@switchboard/web-alerts";
import { idbStore } from "@switchboard/web-core";

declare const RELAY_URL: string;

serviceWorker(self as unknown as SwScope, {
  relayUrl: RELAY_URL,
  store: idbStore(),
  maxActions: () => (globalThis as { Notification?: { maxActions?: number } }).Notification?.maxActions ?? 0,
});
