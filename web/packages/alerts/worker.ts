// sw.js телефона и пульта: служебный обработчик пушей; точка входа сборки оболочки web/build.mjs.
// Адрес relay — из списка сборки build.json рядом (Worker relay в его карте workers): своего адреса у обработчика нет.
import { relayWs } from "@switchboard/relay";
import { serviceWorker, type SwScope } from "@switchboard/web-alerts";
import { idbStore } from "@switchboard/web-core";

serviceWorker(self as unknown as SwScope, {
  relayUrl: fetch("./build.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((b: { workers: Record<string, string> }) => relayWs(b.workers)),
  store: idbStore(),
  maxActions: () => (globalThis as { Notification?: { maxActions?: number } }).Notification?.maxActions ?? 0,
});
