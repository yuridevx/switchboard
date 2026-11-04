// web-chat — лента сессии, ввод и переписка с владельцем. Здесь только связка с ядром; состояние — state/, вид — компоненты.
import type { App, AppModule } from "@switchboard/web-core";
import type {} from "@switchboard/web-ask";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { sessionLine, stateLabel } from "@switchboard/web-ui";
import base from "./chat.css";
import { ChatScreen } from "./ChatScreen.tsx";
import { createChatStore } from "./state/chat.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createChat(app: App): AppModule {
  const chat = createChatStore(app);

  return {
    state: chat,
    frames: { "session.events": chat.onEvents, message: chat.onMessage },
    on: { roster: chat.onRoster, link: chat.onLink },
    screens: {
      chat: {
        label: "Лента",
        view: ChatScreen,
        head: (params) => {
          const callsign = params.callsign ?? "";
          const s = chat.sessionOf(callsign);
          if (!s) return { title: chat.nameOf(callsign), mono: true, sub: `${machineOf(callsign)} не на связи` };
          const st = stateLabel(s.state);
          return { title: chat.nameOf(callsign), mono: true, sub: sessionLine(s, true), pill: { text: st.text, tone: st.tone } };
        },
      },
    },
    marks: { unread: chat.unread },
    store: ["drafts"],
    css: base,
    start: chat.start,
    stop: chat.stop,
  };
}
