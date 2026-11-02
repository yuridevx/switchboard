// sw.js телефона и пульта: служебный обработчик пушей; точка входа сборки оболочки web/build.mjs.
// Адрес relay — из списка сборки build.json рядом: своего адреса у обработчика нет.
import { serviceWorker, type SwScope } from "@switchboard/web-alerts";
import { idbStore } from "@switchboard/web-core";

serviceWorker(self as unknown as SwScope, {
  relayUrl: fetch("./build.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((b: { relay: string }) => b.relay),
  store: idbStore(),
  maxActions: () => (globalThis as { Notification?: { maxActions?: number } }).Notification?.maxActions ?? 0,
});
