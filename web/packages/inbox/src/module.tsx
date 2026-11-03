// web-inbox — «Вам»: что ждёт вас. Здесь — только связка с ядром: состояние — store.ts, вид — InboxScreen.tsx.
import type { AppModule } from "@switchboard/web-core";
import { InboxCtx } from "./context.ts";
import css from "./inbox.css";
import { InboxScreen } from "./InboxScreen.tsx";
import { createInboxStore } from "./store.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createInbox(): AppModule {
  const inbox = createInboxStore();
  return {
    on: { roster: inbox.onRoster, current: inbox.onCurrent },
    screens: {
      inbox: {
        nav: "Вам",
        mark: "you",
        label: "Вам",
        path: "inbox",
        view: () => (
          <InboxCtx.Provider value={inbox}>
            <InboxScreen />
          </InboxCtx.Provider>
        ),
        head: () => ({ title: "Вам" }),
      },
    },
    marks: { you: inbox.count },
    css,
    start: inbox.start,
  };
}
