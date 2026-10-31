// sw.js телефона: служебный обработчик пушей из web-alerts.
import { serviceWorker, type SwScope } from "@switchboard/web-alerts";
import { idbStore } from "@switchboard/web-core";

declare const RELAY_URL: string;

serviceWorker(self as unknown as SwScope, {
  relayUrl: RELAY_URL,
  store: idbStore(),
  maxActions: () => (globalThis as { Notification?: { maxActions?: number } }).Notification?.maxActions ?? 0,
});
