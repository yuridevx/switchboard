// sw.js телефона и пульта: служебный обработчик пушей; точка входа сборки оболочки web/build.mjs.
// Адрес relay — из списка сборки build.json рядом (Worker relay в его карте workers): своего адреса у обработчика нет.
// Берёт только свои части web-alerts и ядра: рантайма страницы в обработчике нет.
import { withLimit } from "@switchboard/protocol";
import { relayWs } from "@switchboard/relay";
import { serviceWorker, type SwScope } from "@switchboard/web-alerts/sw";
import { idbStore } from "@switchboard/web-core/store";

/** Предел чтения списка сборки. */
const LIST_MS = 30_000;

serviceWorker(self as unknown as SwScope, {
  relayUrl: withLimit(
    fetch("./build.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { workers: Record<string, string> }) => relayWs(b.workers)),
    LIST_MS,
    () => {
      throw new Error("build.json не ответил");
    },
  ),
  store: idbStore(),
  maxActions: () => (globalThis as { Notification?: { maxActions?: number } }).Notification?.maxActions ?? 0,
});
