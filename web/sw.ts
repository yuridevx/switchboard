// Обработчик пушей приложения: классический скрипт без рантайма страницы. Сколько кнопок вмещает уведомление, знает браузер; не говорит — ни одной.
import { relayWs } from "@switchboard/relay";
import { serviceWorker, type SwScope } from "@switchboard/web-alerts/sw";
import { idbStore } from "@switchboard/web-core/store";
import { readList } from "./list.ts";

const browser = globalThis as { Notification?: { maxActions?: number } };

serviceWorker(self as unknown as SwScope, {
  relayUrl: readList().then((list) => relayWs(list.workers)),
  store: idbStore(),
  maxActions: () => browser.Notification?.maxActions ?? 0,
});
