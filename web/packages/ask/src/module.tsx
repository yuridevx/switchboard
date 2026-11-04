// web-ask — вопросы сессий: кадры question и answered, запросы answer и question.list, экран вопроса, метка asked для списка.
// Ждущие вопросы держит модуль questions на Host. Здесь — только связка с ядром; состояние — store.ts.
import type { AppModule, ScreenProps } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import css from "./ask.css";
import { AskScreen } from "./AskScreen.tsx";
import { AskCtx } from "./context.ts";
import { createAskStore } from "./store.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createAsk(): AppModule {
  const ask = createAskStore();
  return {
    frames: { question: ask.onQuestion, answered: ask.onAnswered },
    on: { roster: ask.onRoster, link: ask.onLink },
    screens: {
      ask: {
        label: "Вопрос",
        view: (p: ScreenProps) => (
          <AskCtx.Provider value={ask}>
            <AskScreen {...p} />
          </AskCtx.Provider>
        ),
        head: ask.head,
      },
    },
    marks: { asked: ask.asked, "asked.tool": ask.askedTool },
    css,
    start: ask.start,
  };
}
