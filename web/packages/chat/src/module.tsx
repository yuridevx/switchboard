// Модуль чата: экран разговора, метки и команда. Состояние — в state/chat.ts, вид — в ChatScreen.
import type { AppModule, AppPart } from "@switchboard/web-core";
import { sessionLabel, sessionLine, sessionOf, stateLabel, type App } from "@switchboard/web-ui";
import { ChatScreen } from "./ChatScreen.tsx";
import { createState } from "./state/chat.ts";
import css from "./chat.css";

export const createChat: AppPart["module"] = (app: App): AppModule => {
  const chat = createState(app);
  return {
    state: chat,
    store: ["drafts"],
    css,
    frames: chat.module.frames,
    on: chat.module.on,
    start: chat.module.start,
    stop: chat.module.stop,
    screens: {
      chat: {
        label: "Лента",
        path: "chat",
        view: ChatScreen,
        head: (p) => {
          const title = sessionLabel(app, p.callsign).text;
          const s = sessionOf(app, p.callsign);
          if (!s) return { title, mono: true, sub: `${chat.machineOf(p.callsign)} не на связи` };
          const st = stateLabel(s.state);
          return { title, mono: true, sub: sessionLine(s, true), pill: { text: st.text, tone: st.tone } };
        },
      },
    },
    commands: {
      "models.load": { run: (p) => void chat.loadModels(p.callsign) },
    },
    marks: {
      unread(callsign) {
        const c = chat.store.get().convs[callsign];
        return c?.unread ? { count: c.unread, text: c.unreadText } : undefined;
      },
      models: (callsign) => chat.store.get().convs[callsign]?.models,
    },
  };
};
