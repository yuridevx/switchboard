// Модуль разговора с сессией: стор разговоров, кадры ленты и сообщений, экран chat, метки unread и models.
import { isLive, sessionLabel, sessionLine, sessionOf, stateLabel, type App } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";
import css from "./chat.css";
import { createTalks, machineOf } from "./talk.ts";
import { ChatScreen } from "./view/Screen.tsx";

export function createChat(app: App): AppModule {
  const talks = createTalks(app);
  return {
    state: talks,
    frames: talks.frames as AppModule["frames"],
    on: { roster: talks.roster, link: talks.link },
    screens: {
      chat: {
        label: "Лента",
        view: ChatScreen,
        head({ callsign }) {
          const s = sessionOf(app, callsign);
          const st = stateLabel(s?.state);
          return { title: sessionLabel(app, callsign).text, mono: true, sub: s ? sessionLine(s, true) : `${machineOf(callsign)} не на связи`, ...(s ? { pill: { text: st.text, tone: st.tone } } : {}) };
        },
      },
    },
    marks: {
      unread: (cs: string) => talks.get(cs).unread ?? undefined,
      models(cs: string) {
        const m = talks.get(cs).models;
        return Array.isArray(m) ? m : undefined;
      },
    },
    commands: {
      "models.load": {
        run(p) {
          if (isLive(sessionOf(app, p.callsign)?.state)) void talks.models(p.callsign);
        },
      },
    },
    store: ["drafts"],
    css,
    start: talks.start,
    stop: talks.stop,
  };
}
