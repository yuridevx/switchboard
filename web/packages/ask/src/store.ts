// Состояние вопросов сессий: память экрана поверх модуля questions на Host, где ждущие вопросы и живут.
// Кадры question и answered, запросы answer и question.list; снимок читают экран, метка asked и шапка.
import type { App, Frame, Params, Roster } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { createStore, hhmm, sessionLabel } from "@switchboard/web-ui";
import { permLine, type PermFrame } from "./perm.ts";

/** Вопрос AskUserQuestion: 1–4 на кадр, по 2–4 варианта; «Свой ответ» есть всегда. */
export type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
};

export type Status = "waiting" | "sending" | "ok" | "late" | "cancelled" | "gone" | "error";

/** Вопрос сессии в памяти модуля. */
export type Rec = {
  id: string;
  callsign: string;
  kind: string;
  questions: Question[];
  /** форма MCP: message, schema, url, server */
  frame: Frame;
  to: string[];
  at: number;
  status: Status;
  error?: string;
  /** кто ответил и что — из answered или свой ответ */
  by?: string;
  answers?: Record<string, string>;
};

type State = {
  /** вопросы в порядке прихода */
  recs: Rec[];
  /** позывные, у которых надо взять question.list: пришёл пуш без вопросов */
  need: Record<string, true>;
  /** у кого question.list уже взят после этого hello */
  listed: Record<string, true>;
  /** позывной → идёт загрузка списка */
  loading: Record<string, true>;
  /** позывной → слово отказа последнего question.list */
  refused: Record<string, string>;
};

/** Ответ ещё можно менять: ждёт или не дошёл. */
export const isLocked = (r: Rec) => r.status !== "waiting" && r.status !== "error";

function added(recs: Rec[], callsign: string, f: Frame | Record<string, unknown>, to: string[] = []): Rec[] {
  const id = String(f.question);
  if (recs.some((r) => r.id === id)) return recs;
  return [
    ...recs,
    {
      id,
      callsign,
      kind: typeof f.kind === "string" ? f.kind : "ask",
      questions: Array.isArray(f.questions) ? (f.questions as Question[]) : [],
      frame: f as Frame,
      to,
      at: Date.now(),
      status: "waiting",
    },
  ];
}

export type AskStore = ReturnType<typeof createAskStore>;

export function createAskStore() {
  let app: App;
  const store = createStore<State>({ recs: [], need: {}, listed: {}, loading: {}, refused: {} }, () => app.changed());

  const waitingOf = (callsign: string) => store.get().recs.filter((r) => r.callsign === callsign && r.status === "waiting");
  const editRec = (id: string, change: (r: Rec) => void) =>
    store.set((s) => {
      const r = s.recs.find((x) => x.id === id);
      if (r) change(r as Rec);
    });

  /** Ждущие вопросы сессии — у модуля questions её Host. */
  async function list(callsign: string, force = false) {
    if (!force && store.get().listed[callsign]) return;
    store.set((s) => {
      s.listed[callsign] = true;
      s.loading[callsign] = true;
    });
    const r = await app.request<Array<Record<string, unknown>>>("question.list", { callsign });
    store.set((s) => {
      delete s.loading[callsign];
      if (!r.ok) {
        // отказ — словом на экране вопроса, а не «нет ждущих вопросов»
        s.refused[callsign] = r.error;
        delete s.listed[callsign];
        return;
      }
      delete s.refused[callsign];
      delete s.need[callsign];
      const ids = new Set(r.result.map((q) => String(q.question)));
      // ждущие, которых Host больше не знает, — на них уже ответили
      let recs = (s.recs as Rec[]).filter((w) => w.callsign !== callsign || w.status !== "waiting" || ids.has(w.id));
      for (const q of r.result) recs = added(recs, callsign, q);
      (s as State).recs = recs;
    });
  }

  /** Машина сессии на связи: её соединение открыто и её roster пришёл — вопросы спрашиваются у её Host. */
  const present = (callsign: string) => !!app.roster()?.machines.some((m) => m.machine === machineOf(callsign));

  /** Сессии, чьи вопросы нужно спросить: из уведомлений без тела и с ждущими вопросами. */
  const wanted = () => {
    const s = store.get();
    return new Set([...Object.keys(s.need), ...s.recs.filter((r) => r.status === "waiting").map((r) => r.callsign)]);
  };

  /** Вопрос на экране: первый ещё не закрытый; все закрыты — итог последнего. Одна чистая выборка для всех мест экрана. */
  function current(callsign: string): Rec | undefined {
    const own = store.get().recs.filter((r) => r.callsign === callsign);
    return own.find((r) => r.status === "waiting" || r.status === "sending" || r.status === "error") ?? own.at(-1);
  }

  return {
    start(a: App) {
      app = a;
    },
    list,
    current,
    isLoading: (callsign: string) => !!store.get().loading[callsign],
    refusedOf: (callsign: string) => store.get().refused[callsign],
    /** Имя этого устройства и кто ещё видит вопрос: подпись под ответом. */
    othersOf: (r: Rec) => r.to.filter((x) => x !== app.name),

    /** Ответ человека: первый ответ выигрывает, свой повторно не шлётся. */
    async answer(r: Rec, body: Record<string, unknown>, mine?: Record<string, string>) {
      editRec(r.id, (x) => {
        x.status = "sending";
        x.error = undefined;
      });
      const res = await app.request("answer", { callsign: r.callsign, question: r.id, ...body });
      editRec(r.id, (x) => {
        if (res.ok) {
          x.status = "ok";
          x.by = app.name;
          x.answers = mine;
        } else if (res.error === "already_answered") {
          if (x.status === "sending") x.status = "late";
        } else if (res.error === "unknown_question") x.status = "gone";
        else {
          x.status = "error";
          x.error = res.error;
        }
      });
    },

    onQuestion(f: Frame, ctx: { open: boolean }) {
      const callsign = String(f.from);
      if (Array.isArray(f.questions) || f.kind === "form" || f.kind === "perm") {
        store.set((s) => void ((s as State).recs = added(s.recs as Rec[], callsign, f, Array.isArray(f.to) ? (f.to as string[]) : [])));
      } else {
        // из уведомления: в пуше только notify — сам вопрос берём у Host
        store.set((s) => void (s.need[callsign] = true));
        if (app.link() === "open") void list(callsign, true);
      }
      if (ctx.open) app.open("ask", { callsign });
    },
    onAnswered(f: Frame) {
      editRec(String(f.question), (r) => {
        if (f.cancelled) r.status = "cancelled";
        else if (r.status !== "ok") {
          r.by = typeof f.by === "string" ? f.by : undefined;
          r.answers = f.answers as Record<string, string> | undefined;
          r.status = r.by === app.name && r.status === "sending" ? "ok" : "late";
        }
      });
    },
    onRoster(ro: Roster) {
      // машина появилась в roster флота — спросить вопросы её сессий, которых ждём
      for (const c of wanted()) if (present(c)) void list(c);
      for (const s of ro.sessions) if (s.state === "waiting" && !waitingOf(s.callsign).length) void list(s.callsign);
    },
    onLink(state: string) {
      if (state !== "open") return;
      store.set((s) => void (s.listed = {}));
      for (const c of wanted()) if (present(c)) void list(c);
    },

    /** Метка для списка: текст первого ждущего вопроса сессии. */
    asked(callsign: string): string | undefined {
      const r = waitingOf(callsign)[0];
      if (!r) return undefined;
      if (r.kind === "perm") return permLine(r.frame as unknown as PermFrame);
      return r.questions[0]?.question ?? (typeof r.frame.message === "string" ? r.frame.message : "форма");
    },
    /** Метка для карточки инструмента: его запрос разрешения ждёт ответа человека. */
    askedTool: (callsign: string, toolUseId: string) => waitingOf(callsign).some((r) => r.id === toolUseId && r.kind === "perm"),
    /** Шапка экрана вопроса. */
    head(params: Params) {
      const callsign = params.callsign ?? "";
      const r = current(callsign);
      const pill =
        !r || r.status === "waiting" || r.status === "sending" || r.status === "error"
          ? { text: "ждёт ответа", tone: "wait" as const }
          : r.status === "ok"
            ? { text: "ответ принят", tone: "ok" as const }
            : { text: r.status === "cancelled" ? "снят" : "уже ответили", tone: "" as const };
      const name = sessionLabel(app, callsign);
      return { title: name.text, mono: !name.human, sub: r ? `вопрос сессии · ${hhmm(r.at)}` : "вопрос сессии", pill: r || store.get().loading[callsign] ? pill : undefined };
    },
  };
}
