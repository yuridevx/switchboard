// Обработчик пушей пульта и телефона: адрес relay — из списка сборки рядом, остальное — у web-alerts.
// Отдельный бандл: рантайма страницы в нём нет.
import { relayWs } from "@switchboard/relay";
import { serviceWorker, type SwScope } from "@switchboard/web-alerts/sw";
import { idbStore } from "@switchboard/web-core/store";
import { readList } from "./list.ts";

const late = (): never => {
  throw new Error("build.json не ответил");
};

serviceWorker(self as unknown as SwScope, {
  relayUrl: readList<{ workers: Record<string, string> }>(late).then((list) => relayWs(list.workers)),
  store: idbStore(),
  maxActions: () => (globalThis as { Notification?: { maxActions?: number } }).Notification?.maxActions ?? 0,
});
