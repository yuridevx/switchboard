// Вопросы человеку: AskUserQuestion, запрос разрешения и формы MCP. Вопрос ждёт ответа без предела; первый ответ выигрывает.
import type { DecideOpts, ElicitationRequest, ElicitationResult, Frame, Host, PermissionResult, Session } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { isPerson, kindOf } from "@switchboard/protocol";

const REFUSAL = "The user doesn't want to proceed with this tool use.";
const PLAN_ALWAYS = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];

type Kind = "ask" | "form" | "url" | "perm";
type Answer = { by: string; body: Frame };
type Pending = { id: string; kind: Kind; fields: Record<string, unknown>; to: string[]; clients: string[]; settle(a: Answer): void };
type Q = { questions?: Array<{ question?: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string }> }> };

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Вопросы и варианты строками. */
const asLines = (questions: Q["questions"]) => (questions ?? []).flatMap((q) => [`${q.question ?? ""}${q.multiSelect ? " (можно несколько — через запятую)" : ""}`, ...(q.options ?? []).map((o) => `· ${o.label}${o.description ? ` — ${o.description}` : ""}`)]);

/** Вопрос дочери во вводе сессии-адресата. */
function asText(f: Frame): string {
  const lines = asLines(f.questions as Q["questions"]);
  return `<fleet-question from="${f.from}" question="${f.question}">\n${lines.join("\n")}\nОтветь инструментом fleet.answer: to — ${f.from}, question — ${f.question}, answers — { "текст вопроса": "вариант" }.\n</fleet-question>`;
}

export function questions(host: () => Host, viewers: (callsign: string) => string[]) {
  const open = new Map<string, Map<string, Pending>>();
  const closed = new Map<string, Set<string>>();
  const of = (cs: string) => open.get(cs) ?? open.set(cs, new Map()).get(cs)!;
  const done = (cs: string) => closed.get(cs) ?? closed.set(cs, new Set()).get(cs)!;

  /** Кому: давший задачу и зрители сейчас; разрешение и форму решает только человек. */
  const audience = (s: Session, kind: Kind) => [...new Set([s.info.from, ...viewers(s.info.callsign)])].filter((a): a is string => !!a && (isPerson(a) || (kind === "ask" && kindOf(a) === "session")));

  function notify(s: Session, p: Pending, notify: Record<string, unknown>, type: string) {
    if (p.clients.length) void host().request("notify", { clients: p.clients, frame: { type, from: s.info.callsign, question: p.id, notify: { ...notify, tag: p.id } } });
  }

  /** Задать вопрос и ждать первого ответа; сигнал отмены снимает его. */
  function ask<T>(s: Session, id: string, kind: Kind, fields: Record<string, unknown>, signal: AbortSignal, answer: (a: Answer) => T, cancelled: T): Promise<T> {
    const cs = s.info.callsign;
    const to = audience(s, kind);
    host().log({ kind: "note", ev: "question", callsign: cs, question: id, asked: kind, to, ...(to.length ? {} : { why: "адресатов нет: ждёт question.list" }) });
    return new Promise<T>((resolve) => {
      const p: Pending = { id, kind, fields: defined(fields), to, clients: to.filter(isPerson), settle: () => {} };
      const close = (frame: Record<string, unknown>) => {
        of(cs).delete(id);
        done(cs).add(id);
        signal.removeEventListener("abort", abort);
        p.to = audience(s, kind);
        p.clients = p.to.filter(isPerson);
        if (p.to.length) host().emit({ type: "answered", from: cs, to: p.to, question: id, ...frame });
      };
      p.settle = (a) => {
        const { answers, action, content } = a.body;
        close(defined({ by: a.by, answers, action, content }));
        const said = answers ? Object.values(answers as Record<string, string>).join(", ") : String(action ?? "");
        notify(s, p, { title: `${cs} · ответ принят`, body: `${a.by}: ${said}` }, "answered");
        resolve(answer(a));
      };
      const abort = () => {
        close({ cancelled: true });
        notify(s, p, { title: cs, body: "вопрос снят" }, "answered");
        resolve(cancelled);
      };
      signal.addEventListener("abort", abort);
      of(cs).set(id, p);
      if (to.length) host().emit({ type: "question", from: cs, to, question: id, kind, ...p.fields });
      const first = p.fields.questions as Q["questions"];
      if (kind === "ask") {
        const one = first?.length === 1 && !first[0].multiSelect ? first[0] : undefined;
        const actions = one?.options?.map((o) => ({ title: o.label, frame: { type: "answer", v: 1, callsign: cs, question: id, answers: { [one.question!]: o.label } } }));
        notify(s, p, { title: `${cs} спрашивает`, body: actions?.length ? (first?.[0]?.question ?? "") : asLines(first).join("\n"), ...(actions?.length ? { actions } : {}) }, "question");
      } else if (kind === "perm") notify(s, p, { title: `${cs} просит разрешения`, body: String(fields.title ?? fields.tool) }, "question");
      else notify(s, p, { title: `${cs} · форма`, body: String(fields.message ?? fields.url ?? "") }, "question");
    });
  }

  const perm = (s: Session, input: Record<string, unknown>, opts: DecideOpts): Promise<PermissionResult> => {
    const tool = opts.tool ?? "";
    const fields = { tool, input, title: opts.title, description: opts.description, reason: opts.decisionReason, blockedPath: opts.blockedPath, suggestions: opts.suggestions };
    return ask<PermissionResult>(s, opts.toolUseID, "perm", fields, opts.signal, ({ body }) => {
      if (body.action === "deny") return { behavior: "deny", message: body.message ? `${REFUSAL} Reason: ${body.message}` : REFUSAL };
      const always = body.always ? (tool === "ExitPlanMode" ? PLAN_ALWAYS : opts.suggestions) : undefined;
      return { behavior: "allow", updatedInput: input, ...(always?.length ? { updatedPermissions: always } : {}) } as PermissionResult;
    }, { behavior: "deny", message: "cancelled" });
  };

  return {
    decide: {
      AskUserQuestion: (s: Session, input: Record<string, unknown>, opts: DecideOpts): Promise<PermissionResult> =>
        ask<PermissionResult>(s, opts.toolUseID, "ask", { questions: input.questions }, opts.signal, ({ body }) => ({ behavior: "allow", updatedInput: { ...input, answers: body.answers } }), { behavior: "deny", message: "cancelled" }),
      "*": (s: Session, input: Record<string, unknown>, opts: DecideOpts): PermissionResult | Promise<PermissionResult> => {
        const mode = s.field("mode");
        if (mode !== "bypassPermissions") return perm(s, input, opts);
        host().log({ kind: "note", ev: "allow", callsign: s.info.callsign, tool: opts.tool, why: `режим ${mode}` });
        return { behavior: "allow", updatedInput: input };
      },
    },
    elicit(s: Session, r: ElicitationRequest, opts: { signal: AbortSignal; requestId: string }): Promise<ElicitationResult> {
      const req = r as unknown as Record<string, unknown>;
      const url = req.mode === "url";
      const fields = { server: req.serverName, message: req.message, ...(url ? { url: req.url } : { schema: req.requestedSchema }) };
      return ask<ElicitationResult>(s, opts.requestId, url ? "url" : "form", fields, opts.signal, ({ body }) => defined({ action: body.action ?? "accept", content: body.content }) as ElicitationResult, { action: "cancel" });
    },
    requests: {
      answer(req: Frame, { from }: { from?: string }) {
        if (!from) throw refuse("bad_frame", "answer: отправитель без адреса");
        const cs = String(req.callsign);
        const id = String(req.question);
        const p = open.get(cs)?.get(id);
        if (!p) throw done(cs).has(id) ? refuse("already_answered", `${id}: на вопрос уже ответили`) : refuse("unknown_question", `${id}: ждущего вопроса с таким id этот Host не знает`);
        const { answers, content, action, message } = req;
        if (p.kind === "ask") {
          if (!answers || typeof answers !== "object") throw refuse("bad_frame", "answer: answers — «текст вопроса → ответ»");
        } else if (p.kind === "perm") {
          if (!isPerson(from)) throw refuse("not_client", `${id}: разрешение решает человек, а не ${from}`);
          if (action !== "allow" && action !== "deny") throw refuse("bad_frame", `answer: action ${String(action)} — allow или deny`);
          if (message !== undefined && typeof message !== "string") throw refuse("bad_frame", "answer: message — строка");
        } else if (!["accept", "decline", "cancel"].includes(String(action ?? "accept")) || (content !== undefined && typeof content !== "object")) throw refuse("bad_frame", "answer: action формы и content — объект формы");
        p.settle({ by: from, body: req });
        return undefined;
      },
      "question.list": (req: Frame) => [...(open.get(String(req.callsign))?.values() ?? [])].map((p) => ({ question: p.id, kind: p.kind, ...p.fields })),
    },
    /** Текст человека из чата, пока сессия спрашивает его: ответ на вопрос, у каждого пункта один текст. Нет такого вопроса — false. */
    reply(s: Session, from: string, text: string): boolean {
      const p = [...of(s.info.callsign).values()].find((x) => x.kind === "ask" && x.to.includes(from));
      if (!p) return false;
      const answers = Object.fromEntries(((p.fields.questions ?? []) as NonNullable<Q["questions"]>).map((q) => [q.question, text]));
      p.settle({ by: from, body: { type: "answer", answers } });
      return true;
    },
    /** Вопрос другой сессии этой машине: сессиям-адресатам — во ввод. */
    frame(f: Frame) {
      for (const a of ([] as unknown[]).concat(f.to ?? [])) host().session(String(a))?.input(asText(f), { priority: "next", origin: { kind: "peer", from: f.from, name: f.from } });
    },
  };
}
