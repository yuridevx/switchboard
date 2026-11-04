// web-ask — вопросы сессий: кадры question и answered, запросы answer и question.list, экран вопроса, метка asked для списка.
// Ждущие вопросы держит модуль questions на Host. Здесь — только связка с ядром; состояние — store.ts.
import type { App, AppModule } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import css from "./ask.css";
import { AskScreen } from "./AskScreen.tsx";
import { createAskStore } from "./store.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createAsk(app: App): AppModule {
  const ask = createAskStore(app);
  return {
    state: ask,
    frames: { question: ask.onQuestion, answered: ask.onAnswered },
    on: { roster: ask.onRoster, link: ask.onLink },
    screens: {
      ask: {
        label: "Вопрос",
        view: AskScreen,
        head: ask.head,
      },
    },
    marks: { asked: ask.asked, "asked.tool": ask.askedTool },
    css,
  };
}
