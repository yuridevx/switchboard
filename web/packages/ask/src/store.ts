// Вопросы сессий на странице: кадры question и answered, сверка с Host запросом question.list. Одно правило сверки: known — список этой сессии уже спрошен.
import { machineOf } from "@switchboard/protocol";
import type { Roster } from "@switchboard/relay";
import { createStore, type App } from "@switchboard/web-ui";

export type Question = {
  question: string;
  kind: "ask" | "form" | "url" | "perm";
  questions?: Array<{ question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }>;
  message?: string;
  server?: string;
  schema?: { properties?: Record<string, { type?: string; title?: string; description?: string; enum?: unknown[] }> };
  url?: string;
  tool?: string;
  input?: Record<string, unknown>;
  title?: string;
  description?: string;
  reason?: string;
  blockedPath?: string;
  suggestions?: Array<Record<string, unknown>>;
  to?: string[];
};

/** Чем кончился вопрос. */
export type Done = { how: "mine" | "other" | "already" | "cancelled" | "gone"; by?: string; text?: string; word?: string };
export type Entry = { q: Question; at: number; sending: boolean; word: string; done?: Done };
export type Asks = { items: Entry[]; loading: boolean; word: string };

const EMPTY: Asks = { items: [], loading: false, word: "" };

export type AskStore = ReturnType<typeof createAskStore>;

const subjectOf = (q: Question) => String(q.input?.command ?? q.input?.file_path ?? q.input?.url ?? q.input?.pattern ?? "");

/** Текст вопроса для строки списка. */
export function askedText(q: Question): string {
  if (q.kind === "ask") return String(q.questions?.[0]?.question ?? "вопрос");
  if (q.kind === "perm") return q.tool === "ExitPlanMode" ? "План на одобрение" : (q.title ?? [q.tool, subjectOf(q)].filter(Boolean).join(": "));
  return q.message || "форма";
}

export function createAskStore(app: App) {
  const store = createStore<{ asks: Record<string, Asks> }>({ asks: {} }, () => app.changed());
  /** Список сессии спрошен: заново — после новой связи, закрытого вопроса, конца ожидания. */
  const known = new Set<string>();
  /** Вопрос из уведомления без тела: взять у Host, как только будет связь. */
  const wanted = new Set<string>();
  const mounted = new Map<string, number>();
  const waiting = new Set<string>();
  const turns = new Map<string, number>();

  const asks = (cs: string) => store.get().asks[cs] ?? EMPTY;
  const edit = (cs: string, fn: (a: Asks) => void) => store.set((d) => fn((d.asks[cs] ??= { items: [], loading: false, word: "" })));
  const openOf = (a: Asks) => a.items.find((e) => !e.done);

  /** Ответ Host — правда о ждущих: закрытые остаются для экрана, известные сохраняют выбор. */
  async function list(cs: string) {
    known.add(cs);
    const turn = (turns.get(cs) ?? 0) + 1;
    turns.set(cs, turn);
    edit(cs, (a) => void (a.loading = true));
    const r = await app.read<Question[]>("question.list", { callsign: cs });
    if (turns.get(cs) !== turn) return;
    if (!r.ok) {
      known.delete(cs);
      return edit(cs, (a) => {
        a.loading = false;
        a.word = `question.list: ${r.error}`;
      });
    }
    wanted.delete(cs);
    edit(cs, (a) => {
      a.loading = false;
      a.word = "";
      const was = a.items;
      a.items = [...was.filter((e) => e.done), ...r.result.map((q) => was.find((e) => e.q.question === q.question) ?? { q, at: Date.now(), sending: false, word: "" })];
    });
  }

  function close(cs: string, id: string, done: Done) {
    known.delete(cs);
    edit(cs, (a) => {
      const e = a.items.find((x) => x.q.question === id);
      if (e && !e.done) {
        e.done = done;
        e.sending = false;
      }
    });
  }

  return {
    asks,
    /** Первый ждущий; ждущих нет — последний закрытый: на нём итог. */
    shown: (cs: string): Entry | undefined => {
      const a = asks(cs);
      return openOf(a) ?? a.items.at(-1);
    },
    asked: (cs: string) => {
      const e = openOf(asks(cs));
      return e ? askedText(e.q) : undefined;
    },
    askedTool: (cs: string, id: string) => !!asks(cs).items.find((e) => !e.done && e.q.kind === "perm" && e.q.question === id),

    onQuestion(f: { from?: string } & Partial<Question>, opened: boolean) {
      const cs = String(f.from);
      if (typeof f.question !== "string") {
        wanted.add(cs);
        void list(cs);
      } else {
        known.add(cs);
        const { type: _t, from: _f, ...rest } = f as Record<string, unknown>;
        const q = rest as unknown as Question;
        edit(cs, (a) => {
          const same = a.items.find((e) => e.q.question === q.question);
          if (same) return;
          // новый вопрос вытесняет закрытые: на экране он, а не итог прежнего
          a.items = [...a.items.filter((e) => !e.done), { q, at: Date.now(), sending: false, word: "" }];
        });
      }
      if (opened) app.open("ask", { callsign: cs });
    },

    onAnswered(f: { from?: string; question?: string; by?: string; cancelled?: boolean; answers?: Record<string, unknown> }) {
      const cs = String(f.from);
      const id = String(f.question);
      if (f.cancelled) return close(cs, id, { how: "cancelled" });
      const me = f.by === app.name || f.by === app.address();
      const mine = me && asks(cs).items.find((e) => e.q.question === id)?.sending;
      const text = Object.values(f.answers ?? {}).join(", ");
      close(cs, id, mine ? { how: "mine", text } : { how: "other", by: f.by, text });
    },

    onRoster(r: Roster) {
      for (const s of r.sessions) {
        const cs = s.callsign;
        const was = waiting.has(cs);
        if (s.state === "waiting") {
          waiting.add(cs);
          if (!known.has(cs)) void list(cs);
        } else if (was) {
          // ждала и перестала, а ответа мы не видели: спросить Host и забыть спрошенное
          waiting.delete(cs);
          if (openOf(asks(cs))) void list(cs);
          known.delete(cs);
        }
      }
    },

    onLink(state: string, machine?: string) {
      if (state !== "open") return;
      const here = (cs: string) => !machine || machineOf(cs) === machine;
      for (const cs of [...known]) if (here(cs)) known.delete(cs);
      const all = new Set([...wanted, ...waiting, ...mounted.keys(), ...Object.keys(store.get().asks).filter((cs) => openOf(asks(cs)))]);
      for (const cs of all) if (here(cs) && !known.has(cs)) void list(cs);
    },

    /** Экран открыт: список спрашивается, если ещё не спрошен. */
    mount(cs: string) {
      mounted.set(cs, (mounted.get(cs) ?? 0) + 1);
      if (!known.has(cs)) void list(cs);
      return () => {
        const n = mounted.get(cs)! - 1;
        if (n) mounted.set(cs, n);
        else mounted.delete(cs);
      };
    },

    /** Ответ человека: первый ответ выигрывает; отказ сети оставляет вопрос открытым. */
    async answer(cs: string, id: string, reply: Record<string, unknown>, text: string) {
      edit(cs, (a) => {
        const e = a.items.find((x) => x.q.question === id);
        if (e) {
          e.sending = true;
          e.word = "";
        }
      });
      const r = await app.request("answer", { callsign: cs, question: id, ...reply });
      if (r.ok) return close(cs, id, { how: "mine", text });
      if (r.error === "already_answered") return close(cs, id, { how: "already" });
      if (r.error === "unknown_question") return close(cs, id, { how: "gone", word: r.error });
      edit(cs, (a) => {
        const e = a.items.find((x) => x.q.question === id);
        if (e) {
          e.sending = false;
          e.word = r.error;
        }
      });
    },
  };
}
