// web-inbox — «Вам»: что ждёт вас. Здесь — только связка с ядром: состояние — state.ts, вид — screen.tsx.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./inbox.css";
import { InboxScreen } from "./screen.tsx";
import { createInboxState } from "./state.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createInbox(app: App): AppModule {
  const inbox = createInboxState(app);
  return {
    state: inbox,
    on: { roster: inbox.onRoster, current: inbox.onCurrent },
    screens: {
      inbox: { nav: "Вам", mark: "you", label: "Вам", path: "inbox", view: InboxScreen, head: () => ({ title: "Вам" }) },
    },
    marks: { you: inbox.count },
    css,
  };
}
