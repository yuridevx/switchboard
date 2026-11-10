// Вопросы человеку: AskUserQuestion, разрешение инструмента, план и формы серверов MCP. Вопрос живёт в строке сессии; первый ответ выигрывает.
import { kindOf, message, personOf, reachSend, Refusal, type Ask } from "@sb/protocol";
import type { DecideOpts, HostApi, PermissionResult, SessionApi } from "../../core/contract.ts";

const REFUSAL = "The user doesn't want to proceed with this tool use.";
const PLAN_ALWAYS = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];

type Q = { question?: string; multiSelect?: boolean; header?: string; options?: Array<{ label?: string; description?: string }> };
type Pending = { ask: Ask; settle(answer: unknown, by: string, via?: "push"): void };

const isHuman = (a: string) => kindOf(a) === "device" || kindOf(a) === "person";

/** Вопрос дочери во вводе сессии-родителя. */
const asText = (from: string, id: string, qs: Q[]): string =>
  `<fleet-question from="${from}" ask="${id}">\n` +
  qs.flatMap((q) => [`${q.question ?? ""}${q.multiSelect ? " (можно несколько — через запятую)" : ""}`, ...(q.options ?? []).map((o) => `· ${o.label}${o.description ? ` — ${o.description}` : ""}`)]).join("\n") +
  `\nОтветь инструментом answer: to — ${from}, ask — ${id}, answer — выбранный вариант.\n</fleet-question>`;

export function questions(host: () => HostApi, asker: (s: SessionApi) => string | undefined, feed: { viewers(cs: string): string[]; push(cs: string, event: unknown): void } = { viewers: () => [], push() {} }) {
  const open = new Map<string, Map<string, Pending>>();
  const closed = new Map<string, Set<string>>();
  const of = (cs: string) => open.get(cs) ?? open.set(cs, new Map()).get(cs)!;
  const done = (cs: string) => closed.get(cs) ?? closed.set(cs, new Set()).get(cs)!;

  /** Позвать того, кто дал задачу: человека — службой, сессию-родителя — во ввод. Звать ли человека на самом деле, решает служба. */
  function call(s: SessionApi, ask: Ask, qs?: Q[]): void {
    const who = asker(s);
    if (!who) return;
    const failed = (e: unknown) => host().log.warn("ask_call", { callsign: s.callsign, to: who, why: (e as Error).message });
    if (isHuman(who)) {
      void host().call(reachSend, { to: personOf(who)!, title: `${s.callsign} ${ask.kind === "question" ? "спрашивает" : "просит разрешения"}`, text: ask.text, callsign: s.callsign, kind: "ask", ask: ask.id, ...(ask.kind === "question" && ask.options?.length ? { options: ask.options.map((o) => o.label) } : {}) }).catch(failed);
    } else if (kindOf(who) === "session" && ask.kind === "question") {
      void host().call(message, { to: who, text: asText(s.callsign, ask.id, qs ?? []) }, { from: s.callsign }).catch(failed);
    }
  }

  /** Задать вопрос и ждать первого ответа; сигнал отмены хода снимает его. */
  function put<T>(s: SessionApi, ask: Ask, signal: AbortSignal, answered: (answer: unknown, by: string) => T, cancelled: T, qs?: Q[]): Promise<T> {
    const cs = s.callsign;
    // кому вопрос и кто его видел, когда он задан
    const to = asker(s);
    if (to) ask.to = to;
    ask.seen = [...new Set([...(to ? [to] : []), ...feed.viewers(cs)])];
    host().log.info("ask", { callsign: cs, ask: ask.id, kind: ask.kind, to });
    return new Promise<T>((resolve) => {
      const close = () => {
        of(cs).delete(ask.id);
        done(cs).add(ask.id);
        signal.removeEventListener("abort", abort);
        s.sync();
      };
      const abort = () => {
        close();
        feed.push(cs, { type: "ask.answered", ask: ask.id, kind: ask.kind, answer: "cancelled", at: Date.now() });
        resolve(cancelled);
      };
      signal.addEventListener("abort", abort);
      of(cs).set(ask.id, {
        ask,
        settle(answer, by, via) {
          close();
          host().log.info("answered", { callsign: cs, ask: ask.id, from: by, ...(via ? { via } : {}) });
          // итог вопроса — в ленту: кто ответил, чем и откуда (кнопкой уведомления — via: push)
          feed.push(cs, { type: "ask.answered", ask: ask.id, kind: ask.kind, by, answer, ...(via ? { via } : {}), at: Date.now() });
          resolve(answered(answer, by));
        },
      });
      s.sync();
      call(s, ask, qs);
    });
  }

  function question(s: SessionApi, input: Record<string, unknown>, opts: DecideOpts): Promise<PermissionResult> {
    const qs = (input.questions ?? []) as Q[];
    const first = qs[0] ?? {};
    const ask: Ask = {
      id: opts.toolUseID, kind: "question", title: first.header, text: first.question ?? "",
      options: (first.options ?? []).map((o) => ({ label: o.label ?? "", ...(o.description ? { about: o.description } : {}) })),
      ...(first.multiSelect ? { multi: true } : {}), tool: "AskUserQuestion", input, at: Date.now(),
    };
    return put<PermissionResult>(s, ask, opts.signal, (answer) => {
      const given = answer as { answers?: Record<string, string> } | string | string[];
      const text = Array.isArray(given) ? given.join(", ") : typeof given === "string" ? given : "";
      const answers = typeof given === "object" && !Array.isArray(given) && given?.answers ? given.answers : Object.fromEntries(qs.map((q) => [q.question, text]));
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }, { behavior: "deny", message: "cancelled" }, qs);
  }

  function permission(s: SessionApi, input: Record<string, unknown>, opts: DecideOpts): Promise<PermissionResult> {
    const plan = opts.tool === "ExitPlanMode";
    const ask: Ask = {
      id: opts.toolUseID, kind: plan ? "plan" : "permission", title: opts.title ?? opts.tool,
      text: plan ? String(input.plan ?? "") : (opts.description ?? opts.title ?? opts.tool),
      options: [{ label: "allow" }, { label: "allow_always" }, { label: "deny" }], tool: opts.tool, input, at: Date.now(),
    };
    return put<PermissionResult>(s, ask, opts.signal, (answer) => {
      const a = (typeof answer === "string" ? { action: answer } : (answer ?? {})) as { action?: string; message?: string };
      if (a.action === "deny") return { behavior: "deny", message: a.message ? `${REFUSAL} Reason: ${a.message}` : REFUSAL };
      const always = a.action === "allow_always" ? (plan ? PLAN_ALWAYS : opts.suggestions) : undefined;
      return { behavior: "allow", updatedInput: input, ...(always?.length ? { updatedPermissions: always } : {}) };
    }, { behavior: "deny", message: "cancelled" });
  }

  return {
    /** Первый ждущий вопрос сессии — в строку. */
    first: (cs: string): Ask | null => open.get(cs)?.values().next().value?.ask ?? null,
    /** Новый процесс сессии: прежние вопросы и отметки ответов не про него. */
    reset(cs: string): void {
      closed.delete(cs);
    },
    forget(cs: string): void {
      open.delete(cs);
      closed.delete(cs);
    },
    decide(s: SessionApi, input: Record<string, unknown>, opts: DecideOpts): PermissionResult | Promise<PermissionResult> {
      if (opts.tool === "AskUserQuestion") return question(s, input, opts);
      if ((s.spec.mode ?? "all") === "all") return { behavior: "allow", updatedInput: input };
      return permission(s, input, opts);
    },
    elicit(s: SessionApi, req: Record<string, unknown>, opts: { signal: AbortSignal; requestId: string }): Promise<unknown> {
      const url = req.mode === "url";
      const ask: Ask = {
        id: opts.requestId, kind: url ? "url" : "form", title: String(req.serverName ?? ""), text: String(req.message ?? ""),
        ...(url ? { url: String(req.url ?? "") } : { schema: req.requestedSchema }), at: Date.now(),
      };
      return put<unknown>(s, ask, opts.signal, (answer) => {
        const a = (typeof answer === "string" ? { action: answer } : (answer ?? {})) as { action?: string; content?: unknown };
        return { action: a.action ?? "accept", ...(a.content !== undefined ? { content: a.content } : {}) };
      }, { action: "cancel" });
    },
    /** Запрос answer: первый ответ выигрывает. */
    answer(cs: string, id: string, answer: unknown, from: string, via?: "push"): void {
      const p = open.get(cs)?.get(id);
      if (!p) throw done(cs).has(id) ? new Refusal("already_answered", `${id}: на вопрос уже ответили`) : new Refusal("unknown_question", `${id}: ждущего вопроса с таким номером нет`);
      if (p.ask.kind !== "question" && !isHuman(from)) throw new Refusal("not_client", `${id}: это решает человек, а не ${from}`);
      p.settle(answer, from, via);
    },
  };
}
