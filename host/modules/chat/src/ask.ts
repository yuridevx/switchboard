// Вопросы человеку: AskUserQuestion, запрос разрешения и формы MCP. Вопрос ждёт ответа без предела; первый ответ выигрывает.
import type { DecideOpts, ElicitationRequest, ElicitationResult, Frame, Host, PermissionResult, Session } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { kindOf } from "@switchboard/protocol";

const REFUSAL = "The user doesn't want to proceed with this tool use.";
const PLAN_ALWAYS = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];

type Kind = "ask" | "form" | "url" | "perm";
type Answer = { by: string; body: Frame };
type Pending = { id: string; kind: Kind; fields: Record<string, unknown>; to: string[]; clients: string[]; settle(a: Answer): void };
type Q = { questions?: Array<{ question?: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string }> }> };

const isClient = (a: string) => kindOf(a) === "device" || kindOf(a) === "user";
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Вопрос дочери во вводе сессии-адресата. */
function asText(f: Frame): string {
  const lines = ((f.questions ?? []) as NonNullable<Q["questions"]>).flatMap((q) => [q.question ?? "", ...(q.options ?? []).map((o) => `· ${o.label}${o.description ? ` — ${o.description}` : ""}`)]);
  return `<fleet-question from="${f.from}" question="${f.question}">\n${lines.join("\n")}\nОтветь инструментом fleet.answer: to — ${f.from}, question — ${f.question}, answers — { "текст вопроса": "вариант" }.\n</fleet-question>`;
}

export function questions(host: () => Host, viewers: (callsign: string) => string[]) {
  const open = new Map<string, Map<string, Pending>>();
  const closed = new Map<string, Set<string>>();
  const of = (cs: string) => open.get(cs) ?? open.set(cs, new Map()).get(cs)!;
  const done = (cs: string) => closed.get(cs) ?? closed.set(cs, new Set()).get(cs)!;

  function notify(s: Session, p: Pending, notify: Record<string, unknown>, type: string) {
    if (p.clients.length) void host().request("notify", { clients: p.clients, frame: { type, from: s.info.callsign, question: p.id, notify: { ...notify, tag: p.id } } });
  }

  /** Задать вопрос и ждать первого ответа; сигнал отмены снимает его. */
  function ask<T>(s: Session, id: string, kind: Kind, fields: Record<string, unknown>, signal: AbortSignal, answer: (a: Answer) => T, cancelled: T): Promise<T> {
    const cs = s.info.callsign;
    const giver = s.info.from;
    const to = [...new Set([giver, ...viewers(cs)])].filter((a): a is string => !!a && (isClient(a) || (kind === "ask" && kindOf(a) === "session")));
    host().log({ kind: "note", ev: "question", callsign: cs, question: id, asked: kind });
    return new Promise<T>((resolve) => {
      const p: Pending = { id, kind, fields: defined(fields), to, clients: to.filter(isClient), settle: () => {} };
      const close = (frame: Record<string, unknown>) => {
        of(cs).delete(id);
        done(cs).add(id);
        signal.removeEventListener("abort", abort);
        if (to.length) host().emit({ type: "answered", from: cs, to, question: id, ...frame });
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
        notify(s, p, { title: `${cs} · вопрос снят`, body: "ход прервали" }, "answered");
        resolve(cancelled);
      };
      signal.addEventListener("abort", abort);
      of(cs).set(id, p);
      if (to.length) host().emit({ type: "question", from: cs, to, question: id, kind, ...p.fields });
      const first = p.fields.questions as Q["questions"];
      if (kind === "ask") {
        const one = first?.length === 1 && !first[0].multiSelect ? first[0] : undefined;
        const actions = one?.options?.map((o) => ({ title: o.label, frame: { type: "answer", v: 1, callsign: cs, question: id, answers: { [one.question!]: o.label } } }));
        notify(s, p, { title: `${cs} спрашивает`, body: first?.[0]?.question ?? "", ...(actions?.length ? { actions } : {}) }, "question");
      } else notify(s, p, { title: kind === "perm" ? `${cs} просит разрешения` : `${cs} спрашивает`, body: String(fields.title ?? fields.message ?? fields.tool ?? "") }, "question");
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
      answer(req: Frame, ctx: { from?: string }) {
        const cs = String(req.callsign);
        const id = String(req.question);
        const p = open.get(cs)?.get(id);
        if (!p) throw done(cs).has(id) ? refuse("already_answered", `${id}: на вопрос уже ответили`) : refuse("unknown_question", `${id}: ${cs} этого вопроса не ждёт`);
        const good = p.kind === "ask" ? !!req.answers && typeof req.answers === "object" : p.kind === "perm" ? req.action === "allow" || req.action === "deny" : req.action === undefined || ["accept", "decline", "cancel"].includes(String(req.action));
        if (!good) throw refuse("bad_frame", `ответ не той формы для ${p.kind}`);
        if (p.kind !== "ask" && !isClient(ctx.from ?? "")) throw refuse("not_client", `${ctx.from} — не человек`);
        p.settle({ by: ctx.from ?? "", body: req });
        return undefined;
      },
      "question.list": (req: Frame) => [...(open.get(String(req.callsign))?.values() ?? [])].map((p) => ({ question: p.id, kind: p.kind, ...p.fields })),
    },
    /** Вопрос другой сессии этой машине: сессиям-адресатам — во ввод. */
    frame(f: Frame) {
      for (const a of ([] as unknown[]).concat(f.to ?? [])) host().session(String(a))?.input(asText(f), { priority: "next", origin: { kind: "peer", from: f.from, name: f.from } });
    },
  };
}
