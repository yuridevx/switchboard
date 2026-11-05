// web-chat — разговор с сессией: определение модуля. Состояние — store.ts, свёртка — fold.ts, вид — view/.
import { machineOf } from "@switchboard/protocol";
import type { AppModule, Frame, Roster } from "@switchboard/web-core";
import { isLive, sessionLabel, sessionLine, sessionOf, stateLabel, type App } from "@switchboard/web-ui";
import css from "./chat.css";
import { createChats } from "./store.ts";
import { ChatScreen } from "./view/Screen.tsx";

export function createChat(app: App): AppModule {
  const chats = createChats(app);
  return {
    state: chats,
    css,
    store: ["drafts"],
    frames: {
      "session.events": (f: Frame) => chats.onEvents(f),
      message: (f: Frame, ctx) => chats.onMessage(f as never, ctx.open),
    },
    on: {
      link: (state, machine) => chats.onLink(state, machine),
      roster: (r: Roster) => chats.onRoster(r),
    },
    screens: {
      chat: {
        label: "Лента",
        view: ChatScreen,
        head(params) {
          const cs = params.callsign;
          const s = sessionOf(app, cs);
          const st = stateLabel(s?.state);
          return { title: sessionLabel(app, cs).text, mono: true, sub: s ? sessionLine(s, true) : `${machineOf(cs)} не на связи`, ...(s ? { pill: { text: st.text, tone: st.tone } } : {}) };
        },
      },
    },
    marks: {
      unread: (cs) => chats.conv(cs).unread ?? undefined,
      models: (cs) => chats.conv(cs).models,
    },
    commands: {
      "models.load": {
        run(p) {
          if (isLive(sessionOf(app, p.callsign)?.state)) void chats.loadModels(p.callsign);
        },
      },
    },
    start: () => chats.start(),
    stop: () => chats.stop(),
  };
}
