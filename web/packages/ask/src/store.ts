// Вопросы сессий на странице: кадры question и answered, ждущие у Host по question.list. Ответ уходит запросом answer.
import { createStore, type App } from "@switchboard/web-ui";

/** Вопрос как его отдаёт Host: кадр question без конверта или строка question.list. */
export type Question = { question: string; kind: string; to?: string[]; at?: number; [k: string]: unknown };
/** Итог вопроса: ответили (мы или другие), снят, Host его не знает, отказ отправки. */
export type Outcome = { word: "ours" | "theirs" | "late" | "cancelled" | "gone" | "failed"; said?: string; by?: string; error?: string };
export type Asked = Question & { done?: Outcome; sending?: boolean };
type Per = { qs: Asked[]; list?: "loading" | "ok" | { error: string }; waiting?: boolean; want?: boolean };
export type State = Record<string, Per>;

const said = (body: Record<string, unknown>) => (body.answers ? Object.values(body.answers as Record<string, string>).join(", ") : undefined);

export function createAsk(app: App) {
  const store = createStore<State>({}, () => app.changed());
  const per = (s: State, cs: string) => (s[cs] ??= { qs: [] });
  const closed = new Map<string, Set<string>>();
  const isClosed = (cs: string, id: string) => !!closed.get(cs)?.has(id);
  const close = (cs: string, id: string, done: Outcome) => {
    (closed.get(cs) ?? closed.set(cs, new Set()).get(cs)!).add(id);
    store.set((s) => {
      const q = per(s, cs).qs.find((x) => x.question === id);
      if (q) Object.assign(q, { done, sending: false });
    });
  };
  const me = (by: unknown) => by === app.name || by === app.address();

  async function list(cs: string) {
    if (app.link() !== "open") return store.set((s) => void (per(s, cs).want = true));
    store.set((s) => void Object.assign(per(s, cs), { list: "loading", want: false }));
    const r = await app.read<Question[]>("question.list", { callsign: cs });
    store.set((s) => {
      const p = per(s, cs);
      if (!r.ok) return void (p.list = { error: r.error });
      p.list = "ok";
      const ids = new Set(r.result.map((q) => q.question));
      p.qs = p.qs.filter((q) => q.done || ids.has(q.question));
      for (const q of r.result) if (!isClosed(cs, q.question) && !p.qs.some((x) => x.question === q.question)) p.qs.push({ ...q, at: Date.now() });
    });
  }

  const open = (cs: string) => store.get()[cs]?.qs.filter((q) => !q.done) ?? [];

  async function answer(cs: string, q: Asked, body: Record<string, unknown>) {
    store.set((s) => {
      const x = per(s, cs).qs.find((y) => y.question === q.question);
      if (x) Object.assign(x, { sending: true, done: undefined });
    });
    const r = await app.request("answer", { callsign: cs, question: q.question, ...body });
    if (isClosed(cs, q.question)) return;
    const s = said(body) ?? (body.label as string | undefined);
    if (r.ok) close(cs, q.question, { word: "ours", said: s });
    else if (r.error === "already_answered") close(cs, q.question, { word: "late" });
    else if (r.error === "unknown_question") close(cs, q.question, { word: "gone", error: r.error });
    else
      store.set((st) => {
        const x = per(st, cs).qs.find((y) => y.question === q.question);
        if (x) Object.assign(x, { sending: false, done: { word: "failed", error: r.error } });
      });
  }

  return {
    store,
    open,
    answer,
    list,
    frames: {
      question(f: Record<string, unknown>, ctx: { open: boolean }) {
        const cs = String(f.from);
        if (ctx.open) app.open("ask", { callsign: cs });
        if (typeof f.question !== "string" || !f.kind) return void list(cs);
        const id = f.question;
        if (isClosed(cs, id)) return;
        store.set((s) => {
          const p = per(s, cs);
          const { type: _t, from: _f, v: _v, open: _o, ...q } = f;
          if (!p.qs.some((x) => x.question === id)) p.qs.push({ ...(q as Question), at: Date.now() });
        });
      },
      answered(f: Record<string, unknown>) {
        const cs = String(f.from);
        const id = String(f.question);
        if (isClosed(cs, id)) return;
        const mine = store.get()[cs]?.qs.find((q) => q.question === id)?.sending && me(f.by);
        close(cs, id, f.cancelled ? { word: "cancelled" } : mine ? { word: "ours", said: said(f) ?? (f.action as string | undefined) } : { word: "theirs", by: String(f.by ?? ""), said: said(f) });
      },
    },
    /** roster: вошла в ожидание или вышла из него с нашими вопросами — спросить Host; прошлый список отказал — спросить снова. */
    roster(sessions: ReadonlyArray<{ callsign: string; state?: unknown }>) {
      for (const s of sessions) {
        const waiting = s.state === "waiting";
        const p = store.get()[s.callsign];
        const was = p?.waiting ?? false;
        const failed = typeof p?.list === "object";
        if (waiting !== was) store.set((st) => void (per(st, s.callsign).waiting = waiting));
        if ((waiting && (!was || failed)) || (!waiting && was && open(s.callsign).length)) void list(s.callsign);
      }
    },
    /** Связь вернулась: спросить сессии с ждущими вопросами и ждущие сессии. */
    relink() {
      for (const [cs, p] of Object.entries(store.get())) if (p.want || p.waiting || p.qs.some((q) => !q.done)) void list(cs);
    },
  };
}
export type Ask = ReturnType<typeof createAsk>;
