// Модуль ask: кадры и метки вокруг стора, экран вопроса. Сверка с Host — в сторе.
import type { AppPart } from "@switchboard/web-core";
import { hhmm, sessionLabel } from "@switchboard/web-ui";
import css from "./ask.css";
import { AskScreen } from "./AskScreen.tsx";
import { askStore } from "./store.ts";
import { markOf } from "./text.ts";

export const createAsk: AppPart["module"] = (app) => {
  const store = askStore(app);
  return {
    state: store,
    css,
    frames: {
      question: (f, ctx) => store.question(f as Record<string, unknown>, ctx.open),
      answered: (f) => store.answered(f as Record<string, unknown>),
    },
    on: {
      roster: (r) => store.roster(r),
      link(state, machine) {
        if (state === "open") store.relink(machine);
      },
      current(c) {
        if (c.screen === "ask" && c.params.callsign) store.visit(c.params.callsign);
      },
    },
    marks: {
      asked(cs) {
        const q = store.pendingOf(cs)[0];
        return q && markOf(q);
      },
      "asked.tool": (cs, id) => store.pendingOf(cs).some((q) => q.kind === "perm" && q.question === id),
    },
    screens: {
      ask: {
        label: "Вопрос",
        path: "ask",
        view: AskScreen,
        head(params) {
          const qs = store.get().byCs[params.callsign];
          const q = qs?.find((x) => !x.closed) ?? qs?.at(-1);
          const closed = q?.closed;
          const pill = !closed ? { text: "ждёт ответа", tone: "wait" as const } : closed.how === "mine" ? { text: "ответ принят", tone: "ok" as const } : { text: closed.how === "cancelled" ? "снят" : "уже ответили", tone: "" as const };
          const name = sessionLabel(app, params.callsign);
          return { title: name.text, mono: !name.human, sub: q ? `вопрос сессии · ${hhmm(q.at)}` : "вопрос сессии", ...(q || store.get().loading[params.callsign] ? { pill } : {}) };
        },
      },
    },
  };
};
