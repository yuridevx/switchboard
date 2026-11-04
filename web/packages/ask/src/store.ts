// Ждущие вопросы сессий: кадры question и answered, сверка с Host через question.list, ответ через answer.
// Истина о ждущих — у Host: страница спрашивает один раз на ожидание и после новой связи, остальное приходит кадрами.
import { machineOf as machineOfAddress } from "@switchboard/protocol";
import type { Roster } from "@switchboard/web-core";
import type { App } from "@switchboard/web-ui";
import { createStore } from "@switchboard/web-ui";

export type Kind = "ask" | "form" | "url" | "perm";

export type AskItem = { question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> };

/** Как вопрос закрылся: ответ этой страницы, ответ с другого места или снятие. */
export type Closed = { how: "mine"; text: string } | { how: "other"; by?: string; text: string } | { how: "cancelled" } | { how: "gone" };

/** Вопрос сессии: поля кадра question плюс что с ним стало на этой странице. */
export type Question = {
  question: string;
  kind: Kind;
  callsign: string;
  /** когда пришёл на страницу */
  at: number;
  to?: string[];
  questions?: AskItem[];
  server?: string;
  message?: string;
  schema?: { properties?: Record<string, Field>; required?: string[] };
  url?: string;
  tool?: string;
  input?: unknown;
  title?: string;
  description?: string;
  displayName?: string;
  reason?: string;
  blockedPath?: string;
  suggestions?: unknown[];
  /** ответ ушёл, подтверждения ещё нет: строка, которую покажем принятой */
  sending?: string;
  /** слово отказа последней отправки */
  refused?: string;
  closed?: Closed;
};

export type Field = { type?: string; title?: string; description?: string; enum?: unknown[] };

type State = {
  /** вопросы сессии: ждущие и последний закрытый */
  byCs: Record<string, Question[]>;
  /** идёт чтение question.list */
  loading: Record<string, true>;
  /** отказ question.list словом */
  listError: Record<string, string>;
};

const machineOf = (cs: string) => machineOfAddress(cs) ?? "";
const answersText = (a: unknown) => (a && typeof a === "object" ? Object.values(a as Record<string, unknown>).map(String).join("; ") : "");

/** Новый вопрос вытесняет закрытые той же сессии; повтор известного — не новость. */
function added(known: Question[], q: Omit<Question, "at">): Question[] {
  if (known.some((k) => k.question === q.question)) return known;
  return [...known.filter((k) => !k.closed), { ...q, at: Date.now() }];
}

export function askStore(app: App) {
  const s = createStore<State>({ byCs: {}, loading: {}, listError: {} }, () => app.changed());
  /** список уже спрошен с этой связи: новое открытие экрана не спрашивает */
  const asked = new Set<string>();
  /** сессия ждала по последнему roster */
  const waiting = new Set<string>();
  /** спросить, как только будет связь: вопрос из уведомления, новая связь */
  const stale = new Set<string>();
  /** экраны, открытые сейчас: после новой связи их спрашиваем в любом состоянии сессии */
  const shown = new Map<string, number>();
  const since = new Map<string, number>();
  /** номер последнего question.list сессии */
  const turns = new Map<string, number>();

  /** Ждут человека: не закрыты, ответ не в пути и не отказан. */
  const pendingOf = (cs: string) => (s.get().byCs[cs] ?? []).filter((q) => !q.closed && q.sending === undefined && !q.refused);

  async function list(cs: string): Promise<void> {
    asked.add(cs);
    stale.delete(cs);
    s.set((d) => void (d.loading[cs] = true));
    const turn = (turns.get(cs) ?? 0) + 1;
    turns.set(cs, turn);
    const r = await app.read<Array<Omit<Question, "callsign" | "at">>>("question.list", { callsign: cs });
    // ответ на прежний запрос устарел: верен только последний
    if (turns.get(cs) !== turn) return;
    s.set((d) => {
      delete d.loading[cs];
      if (!r.ok) {
        d.listError[cs] = r.error;
        return;
      }
      delete d.listError[cs];
      const fresh = Array.isArray(r.result) ? r.result : [];
      const ids = new Set(fresh.map((q) => q.question));
      // ждущий, которого Host не назвал, закрыт без нас; закрытый и отвеченный здесь поздний ответ не трогает
      let kept = (d.byCs[cs] ?? []).filter((q) => q.closed || q.sending !== undefined || q.refused || ids.has(q.question)) as Question[];
      for (const q of fresh) kept = added(kept, { ...q, callsign: cs });
      d.byCs[cs] = kept;
    });
    if (!r.ok) {
      // следующий roster спросит снова
      asked.delete(cs);
      waiting.delete(cs);
    }
  }

  /** Новая связь с машиной: прежнему списку веры нет. */
  function relink(machine?: string): void {
    const mine = (cs: string) => !machine || machineOf(cs) === machine;
    for (const cs of [...asked]) if (mine(cs)) asked.delete(cs);
    for (const cs of [...waiting]) if (mine(cs)) waiting.delete(cs);
    for (const cs of Object.keys(s.get().byCs)) if (mine(cs) && pendingOf(cs).length) stale.add(cs);
    for (const cs of shown.keys()) if (mine(cs)) stale.add(cs);
  }

  function roster(r: Roster): void {
    for (const m of r.machines ?? []) {
      const was = since.get(m.machine);
      since.set(m.machine, m.since);
      if (was !== undefined && was !== m.since) relink(m.machine);
    }
    for (const ses of r.sessions ?? []) {
      const cs = ses.callsign;
      if (ses.state === "waiting") {
        if (!waiting.has(cs)) {
          waiting.add(cs);
          void list(cs);
        }
      } else if (waiting.delete(cs)) {
        // перестала ждать, ответа мы не видели: спросить; следующее ожидание спросит снова
        if (pendingOf(cs).length) void list(cs);
        asked.delete(cs);
      }
    }
    for (const cs of [...stale]) void list(cs);
  }

  function question(f: Record<string, unknown>, open: boolean): void {
    const cs = String(f.from);
    if (typeof f.question !== "string" || (!Array.isArray(f.questions) && f.kind !== "form" && f.kind !== "url" && f.kind !== "perm")) {
      // уведомление без тела: сам вопрос — у Host
      if (app.link() === "open" && app.roster()) void list(cs);
      else stale.add(cs);
    } else {
      const { type: _type, from: _from, ...body } = f;
      s.set((d) => void (d.byCs[cs] = added((d.byCs[cs] ?? []) as Question[], { ...(body as unknown as Omit<Question, "at">), callsign: cs })));
    }
    if (open) app.open("ask", { callsign: cs });
  }

  function answered(f: Record<string, unknown>): void {
    const cs = String(f.from);
    // закрытый вопрос: следующее открытие экрана спрашивает Host
    asked.delete(cs);
    if (typeof f.question !== "string") return;
    s.set((d) => {
      const q = (d.byCs[cs] ?? []).find((x) => x.question === f.question);
      if (!q) return;
      if (f.cancelled) q.closed = { how: "cancelled" };
      else if (q.closed?.how !== "mine") {
        const by = typeof f.by === "string" ? f.by : undefined;
        q.closed = by === app.name && q.sending !== undefined ? { how: "mine", text: q.sending } : { how: "other", by, text: answersText(f.answers) };
      }
      delete q.sending;
    });
  }

  /** Послать ответ: первый выигрывает, отказ — словом на экране, кнопки остаются. */
  async function answer(cs: string, id: string, text: string, body: Record<string, unknown>): Promise<void> {
    const at = (d: State) => (d.byCs[cs] ?? []).find((x) => x.question === id);
    s.set((d) => {
      const q = at(d);
      if (!q) return;
      q.sending = text;
      delete q.refused;
    });
    const r = await app.request("answer", { callsign: cs, question: id, ...body });
    s.set((d) => {
      const q = at(d);
      if (!q || q.closed) return;
      const sent = q.sending ?? text;
      delete q.sending;
      if (r.ok) q.closed = { how: "mine", text: sent };
      else if (r.error === "already_answered") q.closed = { how: "other", text: "" };
      else if (r.error === "unknown_question") q.closed = { how: "gone" };
      else q.refused = r.error;
    });
  }

  /** Человек открыл вопросы сессии: при живой связи они приходят кадрами, Host спрашиваем один раз. */
  function visit(cs: string): void {
    if (!asked.has(cs) && app.link() === "open") void list(cs);
  }

  /** Экран вопросов на странице, в том числе в месте чата. */
  function mounted(cs: string): () => void {
    shown.set(cs, (shown.get(cs) ?? 0) + 1);
    visit(cs);
    return () => {
      const n = (shown.get(cs) ?? 1) - 1;
      if (n) shown.set(cs, n);
      else shown.delete(cs);
    };
  }

  return { get: s.get, pendingOf, roster, relink, question, answered, answer, visit, mounted };
}

export type AskStore = ReturnType<typeof askStore>;
