// Модуль questions: вопрос сессии человеку. AskUserQuestion (decide) и форма MCP (elicit) уходят тому, кто дал задачу,
// и зрителям сессии; первый ответ выигрывает, остальные получают already_answered. Ждущий вопрос держит SDK:
// пока decide не вернулся, ход стоит. В хранилище — только кому ушёл вопрос: после перезапуска Host SDK вернёт
// тот же toolUseID, и вопрос уйдёт тем же адресатам. Модуль никогда не отвечает за человека.
import type { DecideOpts, ElicitationRequest, ElicitationResult, Frame, Host, Module, PermissionResult, Session } from "@switchboard/host";
import { kindOf } from "@switchboard/protocol";
import { refuse } from "@switchboard/host";

export type Kind = "ask" | "form" | "url";
export type AskItem = { question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> };

/** Кадр question: вопрос с id, видом и содержимым. */
export type QuestionFrame = { type: "question"; from: string; to: string[]; question: string; kind: Kind; [k: string]: unknown };
/** Кадр answered: вопрос закрыт — by и answers (или action, content), либо cancelled. */
export type AnsweredFrame = { type: "answered"; from: string; to: string[]; question: string; by?: string; answers?: Record<string, string>; action?: string; content?: unknown; cancelled?: true };

/** Ответ человека: ask — answers; form и url — action и content. null — вопрос снят (ход прервали). */
type Answer = { by: string; answers?: Record<string, string>; action?: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } | null;

type Pending = {
  id: string;
  s: Session;
  kind: Kind;
  to: string[];
  /** содержимое вопроса для кадра и question.list */
  body: Record<string, unknown>;
  resolve: (a: Answer) => void;
};

/** Раздел сессии: id вопроса → кому ушёл. Только ждущие AskUserQuestion. */
type Sent = Record<string, string[]>;

const isClient = (a: string) => kindOf(a) === "device" || kindOf(a) === "user";
const isStrMap = (x: unknown): x is Record<string, string> => !!x && typeof x === "object" && !Array.isArray(x) && Object.values(x).every((v) => typeof v === "string");

/** Текст вопроса во ввод сессии, давшей задачу: она ответит инструментом fleet.answer. */
export function questionText(from: string, id: string, questions: AskItem[]): string {
  const lines = [`<fleet-question from="${from}" question="${id}">`];
  for (const q of questions) {
    lines.push(q.question + (q.multiSelect ? " (можно несколько — через запятую)" : ""));
    for (const o of q.options ?? []) lines.push(`· ${o.label}${o.description ? ` — ${o.description}` : ""}`);
  }
  lines.push(`Ответь инструментом fleet.answer: to — ${from}, question — ${id}, answers — { "текст вопроса": "вариант" }.`);
  lines.push("</fleet-question>");
  return lines.join("\n");
}

export function make(): Module {
  let host: Host;
  const pending = new Map<string, Pending>();
  /** закрытые вопросы этого процесса Host: поздний ответ — already_answered */
  const closed = new Set<string>();

  /** Кому вопрос: тот, кто дал задачу, и зрители сессии. */
  async function recipients(s: Session): Promise<string[]> {
    const cs = s.info.callsign;
    const w = await host.request("session.watchers", { callsign: cs });
    if (!w.ok) host.log({ kind: "stop", ev: "question", word: w.error, callsign: cs, why: `session.watchers: ${w.error} — вопрос уходит без зрителей` });
    const viewers = w.ok && Array.isArray(w.result) ? (w.result as string[]) : [];
    const to: string[] = [];
    for (const a of [s.info.from, ...viewers]) if (a && (isClient(a) || kindOf(a) === "session") && a !== cs && !to.includes(a)) to.push(a);
    return to;
  }

  function notify(cs: string, to: string[], frame: Record<string, unknown>): void {
    const clients = to.filter(isClient);
    if (!clients.length) return;
    // ответ push не нужен: кому ушёл пуш, видно в его журнале
    void host.request("notify", { clients, frame: { ...frame, from: cs } });
  }

  function askNotify(cs: string, id: string, kind: Kind, body: Record<string, unknown>) {
    if (kind !== "ask") return { title: `${cs} · форма ${body.server}`, body: String(body.message ?? ""), tag: id };
    const qs = body.questions as AskItem[];
    const one = qs.length === 1 && !qs[0].multiSelect ? qs[0] : null;
    return {
      title: `${cs} спрашивает`,
      body: qs.map((q) => q.question).join(" · "),
      ...(one?.options?.length
        ? { actions: one.options.map((o) => ({ title: o.label, frame: { type: "answer", v: 1, callsign: cs, question: id, answers: { [one.question]: o.label } } })) }
        : {}),
      tag: id,
    };
  }

  /** Вопрос наружу и ожидание первого ответа или отмены хода. */
  async function open(s: Session, id: string, kind: Kind, body: Record<string, unknown>, signal: AbortSignal): Promise<Answer> {
    const cs = s.info.callsign;
    let to: string[];
    if (kind === "ask") {
      const store = s.store<Sent>();
      const was = store.get()?.[id];
      to = was ?? (await recipients(s));
      if (!was) store.update((cur = {}) => ({ ...cur, [id]: to }));
    } else to = await recipients(s);
    const answer = new Promise<Answer>((resolve) => pending.set(id, { id, s, kind, to, body, resolve }));
    if (to.length) host.emit({ type: "question", from: cs, to, question: id, kind, ...body } satisfies QuestionFrame);
    notify(cs, to, { type: "question", notify: askNotify(cs, id, kind, body) });
    host.log({ ev: "question", callsign: cs, question: id, to, why: `${kind} → ${to.join(", ") || "адресатов нет: ждёт question.list"}` });
    if (signal.aborted) close(id, null);
    else signal.addEventListener("abort", () => close(id, null), { once: true });
    return answer;
  }

  /** Закрыть вопрос: запись стёрта, всем адресатам answered, SDK получает ответ. Ответ null — ход прервали. */
  function close(id: string, a: Answer): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    closed.add(id);
    const cs = p.s.info.callsign;
    if (p.kind === "ask") p.s.store<Sent>().update((cur = {}) => {
      const { [id]: _gone, ...rest } = cur;
      return Object.keys(rest).length ? rest : undefined;
    });
    const what = a === null ? { cancelled: true as const } : { by: a.by, ...(a.answers ? { answers: a.answers } : { action: a.action, ...(a.content ? { content: a.content } : {}) }) };
    if (p.to.length) host.emit({ type: "answered", from: cs, to: p.to, question: id, ...what } satisfies AnsweredFrame);
    const text = a === null ? "" : `${a.by}: ${a.answers ? Object.values(a.answers).join(", ") : a.action}`;
    notify(cs, p.to, { type: "answered", notify: { title: `${cs} · ${a === null ? "вопрос снят" : "ответ принят"}`, body: text, tag: id } });
    host.log({ ev: "answered", callsign: cs, question: id, ...(a === null ? { cancelled: true } : { by: a.by }) });
    p.resolve(a);
  }

  return {
    decide: {
      async AskUserQuestion(s, input, opts: DecideOpts): Promise<PermissionResult> {
        const a = await open(s, opts.toolUseID, "ask", { questions: (input.questions ?? []) as AskItem[] }, opts.signal);
        if (a === null) return { behavior: "deny", message: "cancelled" };
        return { behavior: "allow", updatedInput: { ...input, answers: a.answers } };
      },
    },
    async elicit(s, req: ElicitationRequest, opts): Promise<ElicitationResult> {
      const kind: Kind = req.mode === "url" ? "url" : "form";
      const body = kind === "url" ? { server: req.serverName, message: req.message, url: req.url } : { server: req.serverName, message: req.message, schema: req.requestedSchema };
      const a = await open(s, opts.requestId, kind, body, opts.signal);
      if (a === null) return { action: "cancel" };
      return { action: a.action ?? "accept", ...(a.content ? { content: a.content } : {}) } as ElicitationResult;
    },
    requests: {
      answer(req, ctx) {
        const id = req.question as string;
        if (closed.has(id)) throw refuse("already_answered", `${id}: на вопрос уже ответили`);
        const p = pending.get(id);
        if (!p || p.s.info.callsign !== req.callsign) throw refuse("unknown_question", `${String(id)}: ждущего вопроса ${String(req.callsign)} с таким id этот Host не знает`);
        const by = ctx.from ?? "";
        if (p.kind === "ask") {
          if (!isStrMap(req.answers)) throw refuse("bad_frame", "answer: answers — «текст вопроса → ответ»");
          close(id, { by, answers: req.answers });
          return undefined;
        }
        const action = (req.action ?? "accept") as string;
        if (action !== "accept" && action !== "decline" && action !== "cancel") throw refuse("bad_frame", `answer: action ${action}`);
        const content = req.content;
        if (content !== undefined && (!content || typeof content !== "object" || Array.isArray(content))) throw refuse("bad_frame", "answer: content — объект формы");
        close(id, { by, action, ...(content ? { content: content as Record<string, unknown> } : {}) });
        return undefined;
      },
      "question.list"(req) {
        return [...pending.values()].filter((p) => p.s.info.callsign === req.callsign).map((p) => ({ question: p.id, kind: p.kind, ...p.body }));
      },
    },
    frames: {
      // вопрос, адресованный сессии этой машины, — в её ввод: она ответит инструментом fleet.answer
      question(f: Frame) {
        if (f.kind !== "ask" || typeof f.from !== "string") {
          host.log({ ev: "question", why: `${String(f.question)}: вид ${String(f.kind)} — только человеку, во ввод сессии не кладётся` });
          return;
        }
        const to = Array.isArray(f.to) ? f.to : [f.to];
        for (const a of to) {
          const s = kindOf(a) === "session" ? host.session(a as string) : undefined;
          if (!s) continue;
          // вопрос дочери — не новая задача: отправитель последнего ввода родителя прежний, его вопросы — тому, кто дал ему задачу
          s.input(questionText(f.from, String(f.question), (f.questions ?? []) as AskItem[]), { priority: "next", origin: { kind: "peer", from: f.from, name: f.from } });
        }
      },
      // сессии закрытый вопрос не нужен: её fleet.answer уже получил ответ
      answered() {},
    },
    on: {
      // конец хода: ждущих вопросов у сессии нет — её записи стёрты
      event(s, m) {
        if (m.type !== "result") return;
        const store = s.store<Sent>();
        if (store.get() !== undefined) store.set(undefined);
      },
    },
    start(h) {
      host = h;
    },
    // ждущие вопросы не трогать — ни allow, ни deny: это был бы ответ за человека; раздел уже на диске
    stop() {},
  };
}
