// Модуль разговора с сессией: стор разговоров, кадры ленты и сообщений, экран chat, метки unread и models.
import { lamp, linkText, sessionLabel, sessionOf, stateLabel, type App } from "@switchboard/web-ui";
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
        head(params) {
          const s = sessionOf(app, params.callsign);
          const st = stateLabel(s?.state);
          return { title: sessionLabel(app, params.callsign).text, sub: s ? params.callsign : linkText("offline", machineOf(params.callsign)), mono: true, ...(s ? { pill: { text: st.text, tone: st.tone }, dot: lamp(s) } : {}) };
        },
      },
    },
    marks: {
      unread(cs: string) {
        const t = talks.get(cs);
        return t.unread ? { count: t.unread, text: t.unreadText ?? "" } : undefined;
      },
      models(cs: string) {
        const m = talks.get(cs).models;
        return Array.isArray(m) ? m : undefined;
      },
    },
    commands: { "models.load": { run: (p) => void talks.models(p.callsign) } },
    store: ["drafts"],
    css,
    start: talks.start,
    stop: talks.stop,
  };
}
