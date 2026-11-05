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
          const name = sessionLabel(app, params.callsign);
          const pill = !done ? { text: "ждёт ответа", tone: "wait" as const } : done === "mine" ? { text: "ответ принят", tone: "ok" as const } : { text: done === "cancelled" ? "снят" : "уже ответили", tone: "" as const };
          return { title: name.text, mono: !name.human, sub: e ? `вопрос сессии · ${hhmm(e.at)}` : "вопрос сессии", ...(e || asks.asks(params.callsign).loading ? { pill } : {}) };
        },
      },
    },
    marks: {
      asked: (cs) => asks.asked(cs),
      "asked.tool": (cs, id) => asks.askedTool(cs, id),
    },
  };
}
