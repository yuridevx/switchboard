// web-ask — вопросы сессий: определение модуля. Состояние — store.ts, экран — Screen.tsx.
import type { AppModule, Frame } from "@switchboard/web-core";
import { hhmm, sessionLabel, type App } from "@switchboard/web-ui";
import css from "./ask.css";
import { AskScreen } from "./Screen.tsx";
import { createAskStore } from "./store.ts";

export function createAsk(app: App): AppModule {
  const asks = createAskStore(app);
  return {
    state: asks,
    css,
    frames: {
      question: (f: Frame, ctx) => asks.onQuestion(f as never, ctx.open),
      answered: (f: Frame) => asks.onAnswered(f as never),
    },
    on: {
      roster: (r) => asks.onRoster(r),
      link: (state, machine) => asks.onLink(state, machine),
    },
    screens: {
      ask: {
        label: "Вопрос",
        view: AskScreen,
        head(params) {
          const e = asks.shown(params.callsign);
          const done = e?.done?.how;
          return {
            title: sessionLabel(app, params.callsign).text,
            mono: true,
            sub: e ? `вопрос сессии · ${hhmm(e.at)}` : "вопрос сессии",
            ...(done === "mine" ? { pill: { text: "ответ принят", tone: "ok" as const } } : done === "other" || done === "already" ? { pill: { text: "уже ответили", tone: "" as const } } : {}),
          };
        },
      },
    },
    marks: {
      asked: (cs) => asks.asked(cs),
      "asked.tool": (cs, id) => asks.askedTool(cs, id),
    },
  };
}
