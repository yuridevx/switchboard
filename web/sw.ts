// Обработчик пушей страницы: своя сборка без рантайма; адрес relay — из списка сборки, пропуск — из хранилища страницы.
import { relayWs } from "@switchboard/relay";
import { serviceWorker, type SwScope } from "@switchboard/web-alerts/sw";
import { idbStore } from "@switchboard/web-core/store";
import { readList } from "./list.ts";

/** Вместимость кнопок пишет сам браузер; не пишет — кнопок нет. */
const maxActions = () => (globalThis as { Notification?: { maxActions?: number } }).Notification?.maxActions ?? 0;

serviceWorker(self as unknown as SwScope, {
  relayUrl: readList("build.json не ответил").then((list) => relayWs(list.workers)),
  store: idbStore(),
  maxActions,
});
