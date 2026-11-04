// web-chat — лента сессии, ввод и переписка с владельцем. Здесь только связка с ядром; состояние — state/, вид — компоненты.
import type { AppModule, ScreenProps } from "@switchboard/web-core";
import type {} from "@switchboard/web-ask";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { sessionLine, stateLabel } from "@switchboard/web-ui";
import base from "./chat.css";
import { ChatCtx } from "./context.ts";
import { ChatScreen } from "./ChatScreen.tsx";
import { Gallery } from "./gallery/Gallery.tsx";
import { createChatStore } from "./state/chat.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createChat(): AppModule {
  const chat = createChatStore();

  return {
    frames: { "session.events": chat.onEvents, message: chat.onMessage },
    on: { roster: chat.onRoster, link: chat.onLink },
    screens: {
      chat: {
        label: "Лента",
        view: ({ params }: ScreenProps) => (
          <ChatCtx.Provider value={chat}>
            <ChatScreen callsign={params.callsign ?? ""} />
          </ChatCtx.Provider>
        ),
        head: (params) => {
          const callsign = params.callsign ?? "";
          const s = chat.sessionOf(callsign);
          if (!s) return { title: chat.nameOf(callsign), mono: true, sub: `${machineOf(callsign)} не на связи` };
          const st = stateLabel(s.state);
          return { title: chat.nameOf(callsign), mono: true, sub: sessionLine(s, true), pill: { text: st.text, tone: st.tone } };
        },
      },
      gallery: { label: "Галерея", path: "gallery", view: Gallery, head: () => ({ title: "Галерея карточек" }) },
    },
    marks: { unread: chat.unread },
    store: ["drafts"],
    css: base,
    start: chat.start,
    stop: chat.stop,
  };
}
