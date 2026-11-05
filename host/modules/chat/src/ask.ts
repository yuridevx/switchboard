// Вопросы человеку: AskUserQuestion, запрос разрешения, план и формы MCP. Решение за человека модуль не выбирает: ход ждёт ответа или прерывания.
// Вопросы — в памяти: canUseTool новый Host получает от SDK заново с тем же id, форму — нет: её id станет unknown_question.
import { kindOf } from "@switchboard/protocol";
import { refuse, type DecideOpts, type ElicitationRequest, type ElicitationResult, type Frame, type Host, type PermissionResult, type Session } from "@switchboard/host";

const REFUSAL = "The user doesn't want to proceed with this tool use.";
const PLAN_ALWAYS = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];

type Question = { question: string; kind: "ask" | "form" | "url" | "perm"; [field: string]: unknown };
type Reply = Record<string, unknown>;
/** Ждущий вопрос; после ответа остаётся без него: поздний ответ получает already_answered. */
type Entry = { q: Question; settle: ((reply: Reply, by: string) => void) | null };

type Q = { question?: string; options?: Array<{ label?: string; description?: string }>; multiSelect?: boolean };

export function questions(host: () => Host, viewers: (callsign: string) => string[]) {
  const asked = new Map<string, Map<string, Entry>>();
  const of = (callsign: string) => {
    let m = asked.get(callsign);
    if (!m) asked.set(callsign, (m = new Map()));
    return m;
  };

  /** Кому: давший задачу и зрители; разрешение и форму решает только человек. */
  function audience(s: Session, kind: Question["kind"]) {
    const addr = [s.info.from, ...viewers(s.info.callsign)].filter((a): a is string => !!a);
    const human = (a: string) => kindOf(a) === "device" || kindOf(a) === "user";
    return [...new Set(addr)].filter((a) => human(a) || (kind === "ask" && kindOf(a) === "session"));
  }

  function notify(callsign: string, to: string[], frame: Frame) {
    const clients = to.filter((a) => kindOf(a) !== "session");
    if (clients.length) void host().request("notify", { clients, frame: { ...frame, from: callsign } });
  }

  /** Кнопки пуша — только когда один вопрос с одним выбором. */
  function pushOf(callsign: string, q: Question) {
    const list = (q.questions ?? []) as Q[];
    const one = q.kind === "ask" && list.length === 1 && !list[0].multiSelect ? list[0] : null;
    return {
      title: q.kind === "perm" ? `${callsign} просит разрешения` : q.kind === "ask" ? `${callsign} спрашивает` : `${callsign} · форма`,
      body: q.kind === "ask" ? String(list[0]?.question ?? "") : q.kind === "perm" ? String(q.title ?? q.tool) : String(q.message ?? q.url ?? ""),
      tag: q.question,
      ...(one?.options?.length
        ? { actions: one.options.map((o) => ({ title: o.label, frame: { type: "answer", v: 1, callsign, question: q.question, answers: { [String(one.question)]: o.label } } })) }
        : {}),
    };
  }

  /** Вопрос ждёт: кадр и пуш адресатам; ответ или прерывание хода закрывают его. */
  function ask<R>(s: Session, q: Question, signal: AbortSignal, onReply: (r: Reply) => R, onCancel: R): Promise<R> {
    const { callsign } = s.info;
    const to = audience(s, q.kind);
    host().log({ ev: "question", callsign, question: q.question, asked: q.kind, to, ...(to.length ? {} : { why: "адресатов нет: ждёт question.list" }) });
    if (to.length) host().emit({ type: "question", from: callsign, to, ...q });
    notify(callsign, to, { type: "question", ...q, notify: pushOf(callsign, q) });
    return new Promise<R>((resolve) => {
      const entry: Entry = { q, settle: null };
      const close = (frame: Reply, push?: Record<string, unknown>) => {
        entry.settle = null;
        signal.removeEventListener("abort", onAbort);
        const now = audience(s, q.kind);
        if (now.length) host().emit({ type: "answered", from: callsign, to: now, question: q.question, ...frame });
        if (push) notify(callsign, now, { type: "answered", question: q.question, ...frame, notify: push });
      };
      const onAbort = () => {
        close({ cancelled: true }, { title: callsign, body: "вопрос снят", tag: q.question });
        resolve(onCancel);
      };
      entry.settle = (reply, by) => {
        const picked = Object.values((reply.answers ?? {}) as Record<string, unknown>).join(", ") || String(reply.action ?? "");
        close({ by, ...reply }, { title: `${callsign} · ответ принят`, body: `${by}: ${picked}`, tag: q.question });
        resolve(onReply(reply));
      };
      of(callsign).set(q.question, entry);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    /** answer: первый ответ выигрывает. */
    answer(req: Frame, from: string) {
      if (!from) throw refuse("bad_frame", "answer: отправитель без адреса");
      const callsign = String(req.callsign);
      const entry = of(callsign).get(String(req.question));
      if (!entry) throw refuse("unknown_question", `${String(req.question)}: ждущего вопроса с таким id этот Host не знает`);
      if (!entry.settle) throw refuse("already_answered", `${String(req.question)}: на вопрос уже ответили`);
      const { answers, content, action, always, message } = req;
      const { kind } = entry.q;
      if (kind === "ask") {
        if (!answers || typeof answers !== "object") throw refuse("bad_frame", "answer: answers — «текст вопроса → ответ»");
        entry.settle({ answers }, from);
      } else if (kind === "perm") {
        if (!["device", "user"].includes(String(kindOf(from)))) throw refuse("not_client", `${String(req.question)}: разрешение решает человек, а не ${from}`);
        if (action !== "allow" && action !== "deny") throw refuse("bad_frame", `answer: action ${String(action)} — allow или deny`);
        if (message !== undefined && typeof message !== "string") throw refuse("bad_frame", "answer: message — строка");
        entry.settle({ action, ...(always ? { always } : {}), ...(message !== undefined ? { message } : {}) }, from);
      } else {
        const act = action ?? "accept";
        if ((act !== "accept" && act !== "decline" && act !== "cancel") || (content !== undefined && typeof content !== "object")) throw refuse("bad_frame", "answer: action формы и content — объект формы");
        entry.settle({ action: act, ...(content !== undefined ? { content } : {}) }, from);
      }
    },

    list: (callsign: string) => [...of(callsign).values()].filter((e) => e.settle).map((e) => e.q),

    /** Вопрос другой сессии адресату-сессии: во ввод тегом; давший задачу у неё не меняется. */
    intoInput(f: Frame) {
      const list = (f.questions ?? []) as Q[];
      const lines = list.flatMap((q) => [`${String(q.question ?? "")}${q.multiSelect ? " (можно несколько — через запятую)" : ""}`, ...(q.options ?? []).map((o) => `· ${o.label}${o.description ? ` — ${o.description}` : ""}`)]);
      const how = `Ответь инструментом fleet.answer: to — ${f.from}, question — ${String(f.question)}, answers — { "текст вопроса": "вариант" }.`;
      const text = `<fleet-question from="${f.from}" question="${String(f.question)}">\n${[...lines, how].join("\n")}\n</fleet-question>`;
      for (const to of [f.to].flat()) {
        const s = typeof to === "string" ? host().session(to) : undefined;
        s?.input(text, { priority: "next", origin: { kind: "peer", from: f.from, name: f.from } });
      }
    },

    askUser: (s: Session, input: Record<string, unknown>, o: DecideOpts): Promise<PermissionResult> =>
      ask<PermissionResult>(s, { question: o.toolUseID, kind: "ask", questions: input.questions }, o.signal, (r) => ({ behavior: "allow", updatedInput: { ...input, answers: r.answers as string } }), { behavior: "deny", message: "cancelled" }),

    /** Разрешение: в режиме без вопросов — само, иначе человеку. Постоянное правило — только предложенное SDK; у плана — смена режима. */
    permission(s: Session, input: Record<string, unknown>, o: DecideOpts): PermissionResult | Promise<PermissionResult> {
      const { tool = "", toolUseID, signal, suggestions, title, description, decisionReason, blockedPath } = o;
      if (s.field("mode") === "bypassPermissions") {
        host().log({ ev: "allow", callsign: s.info.callsign, tool, why: "режим bypassPermissions" });
        return { behavior: "allow", updatedInput: input };
      }
      const q: Question = { question: toolUseID, kind: "perm", tool, input, title, description, reason: decisionReason, blockedPath, suggestions };
      const always = tool === "ExitPlanMode" ? PLAN_ALWAYS : suggestions;
      return ask<PermissionResult>(
        s,
        q,
        signal,
        (r) =>
          r.action === "allow"
            ? ({ behavior: "allow", updatedInput: input, ...(r.always && always ? { updatedPermissions: always } : {}) } as PermissionResult)
            : { behavior: "deny", message: r.message ? `${REFUSAL} Reason: ${String(r.message)}` : REFUSAL },
        { behavior: "deny", message: "cancelled" },
      );
    },

    form(s: Session, request: ElicitationRequest, o: { signal: AbortSignal; requestId: string }): Promise<ElicitationResult> {
      const r = request as ElicitationRequest & { mode?: string; url?: string; requestedSchema?: unknown };
      const q: Question = r.mode === "url" ? { question: o.requestId, kind: "url", server: r.serverName, message: r.message, url: r.url } : { question: o.requestId, kind: "form", server: r.serverName, message: r.message, schema: r.requestedSchema };
      return ask<ElicitationResult>(s, q, o.signal, (a) => ({ action: a.action, ...(a.content !== undefined ? { content: a.content } : {}) }) as ElicitationResult, { action: "cancel" });
    },
  };
}
