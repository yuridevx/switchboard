// Модуль вопросов сессий: стор, кадры, метки и экран ask.
import { sessionLabel, at, type App } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";
import css from "./ask.css";
import { AskScreen, shownOf, subjectOf } from "./Screen.tsx";
import { createAsk as store } from "./store.ts";

const PILLS = { ours: ["ответ принят", "ok"], theirs: ["уже ответили", ""], late: ["уже ответили", ""], cancelled: ["снят", ""], gone: ["снят", ""], failed: ["ждёт ответа", "wait"] } as const;

export function createAsk(app: App): AppModule {
  const ask = store(app);
  const first = (cs: string) => ask.open(cs)[0];
  return {
    state: ask,
    frames: ask.frames as AppModule["frames"],
    on: {
      roster: (r) => ask.roster(r.sessions),
      link: (state) => void (state === "open" && ask.relink()),
      current(c) {
        if (c.screen === "ask" && c.params.callsign && !first(c.params.callsign)) void ask.list(c.params.callsign);
      },
    },
    screens: {
      ask: {
        label: "Вопрос",
        view: AskScreen,
        head(params) {
          const q = shownOf(ask.store.get()[params.callsign]?.qs);
          const [text, tone] = q?.done ? PILLS[q.done.word] : ["ждёт ответа", "wait"];
          return { title: sessionLabel(app, params.callsign).text, sub: `вопрос сессии${q?.at ? ` · ${at(q.at)}` : ""}`, pill: { text, tone: tone as "ok" | "wait" | "" } };
        },
      },
    },
    marks: {
      asked(cs: string) {
        const q = first(cs);
        if (!q) return undefined;
        if (q.kind === "ask") return String((q.questions as Array<{ question?: string }> | undefined)?.[0]?.question ?? "");
        if (q.kind === "perm") return String(q.title ?? `${q.tool}: ${subjectOf(q.input as Record<string, unknown>)}`);
        return String(q.message || (q.kind === "url" ? "ссылка" : "форма"));
      },
      "asked.tool": (cs: string, id: string) => ask.open(cs).some((q) => q.kind === "perm" && q.question === id),
    },
    css,
  };
}
