// Вопросы сессии человеку: AskUserQuestion, запрос разрешения и форма MCP дают один ждущий вопрос; первый ответ выигрывает.
// Ждущий вопрос держит SDK: после перезапуска Host он вернёт тот же id, и вопрос уйдёт нынешним адресатам.
// Таймера на ожидание человека нет: он решал бы за человека. Предел — «Прервать» и session.stop, оба снимают вопрос (решение 4 нояб.).
import type { DecideOpts, ElicitationRequest, ElicitationResult, Frame, Host, Module, PermissionResult, Session } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { kindOf } from "@switchboard/protocol";

type Kind = "ask" | "form" | "url" | "perm";
type Item = { question: string; multiSelect?: boolean; options?: Array<{ label: string }> };
type Reply = { by: string; answers?: Record<string, string>; action?: string; content?: Record<string, unknown>; always?: boolean; message?: string };
/** Ждущий вопрос; ответ null — ход прервали. */
type Waiting = { id: string; s: Session; kind: Kind; to: string[]; body: Record<string, unknown>; settle(reply: Reply | null): void };

const isClient = (a: unknown) => kindOf(a) === "device" || kindOf(a) === "user";
const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isAnswers = (x: unknown): x is Record<string, string> => isRecord(x) && Object.values(x).every((v) => typeof v === "string");

/** Режим, в котором claude не спрашивает: запроса разрешения человеку нет (устав). */
const NO_QUESTIONS = "bypassPermissions";
/** Отказ словами самого claude: и модель, и чат понимают его одинаково. */
const REFUSAL = "The user doesn't want to proceed with this tool use.";
/** «Всегда» у плана: одобрить и дальше править без вопросов в этой сессии. */
const PLAN_TOOL = "ExitPlanMode";
const KEEP_EDITING = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];

/** Уведомление о новом вопросе: кнопки только там, где ответ — один вариант. */
function pushOf(callsign: string, id: string, kind: Kind, body: Record<string, unknown>) {
  if (kind === "perm") return { title: `${callsign} просит разрешения`, body: String(body.title ?? body.tool ?? ""), tag: id };
  if (kind !== "ask") return { title: `${callsign} · форма ${body.server}`, body: String(body.message ?? ""), tag: id };
  const items = body.questions as Item[];
  const single = items.length === 1 && !items[0].multiSelect ? items[0] : null;
  const actions = single?.options?.map((o) => ({ title: o.label, frame: { type: "answer", v: 1, callsign, question: id, answers: { [single.question]: o.label } } }));
  return { title: `${callsign} спрашивает`, body: items.map((q) => q.question).join(" · "), ...(actions?.length ? { actions } : {}), tag: id };
}

export function makeQuestions(host: () => Host, viewers: (s: Session) => string[]): Pick<Required<Module>, "decide" | "elicit" | "requests"> {
  const waiting = new Map<string, Waiting>();
  /** закрытые вопросы этого процесса Host: поздний ответ — already_answered */
  const done = new Set<string>();

  /** Адресаты: кто дал задачу и зрители; разрешение и форма — только клиентам: их решает человек. */
  function recipients(s: Session, kind: Kind): string[] {
    const all = [s.info.from, ...viewers(s)].filter((a) => isClient(a) || (kindOf(a) === "session" && a !== s.info.callsign)) as string[];
    return [...new Set(kind === "ask" ? all : all.filter(isClient))];
  }

  /** Пуш только клиентам. Ответ не нужен: кому ушёл, видно в журнале пуша. */
  function push(callsign: string, to: string[], frame: Record<string, unknown>): void {
    const clients = to.filter(isClient);
    if (clients.length) void host().request("notify", { clients, frame: { ...frame, from: callsign } });
  }

  function ask(s: Session, id: string, kind: Kind, body: Record<string, unknown>, signal: AbortSignal): Promise<Reply | null> {
    const callsign = s.info.callsign;
    const to = recipients(s, kind);
    const reply = new Promise<Reply | null>((settle) => waiting.set(id, { id, s, kind, to, body, settle }));
    if (to.length) host().emit({ type: "question", from: callsign, to, question: id, kind, ...body });
    push(callsign, to, { type: "question", notify: pushOf(callsign, id, kind, body) });
    host().log({ ev: "question", callsign, question: id, to, why: `${kind} → ${to.join(", ") || "адресатов нет: ждёт question.list"}` });
    if (signal.aborted) close(id, null);
    else signal.addEventListener("abort", () => close(id, null), { once: true });
    return reply;
  }

  /** Закрыть вопрос: адресатам answered, SDK получает ответ. */
  function close(id: string, reply: Reply | null): void {
    const q = waiting.get(id);
    if (!q) return;
    waiting.delete(id);
    done.add(id);
    const callsign = q.s.info.callsign;
    const outcome = !reply ? { cancelled: true } : { by: reply.by, ...(reply.answers ? { answers: reply.answers } : { action: reply.action, ...(reply.content ? { content: reply.content } : {}) }) };
    if (q.to.length) host().emit({ type: "answered", from: callsign, to: q.to, question: id, ...outcome });
    const said = reply ? `${reply.by}: ${reply.answers ? Object.values(reply.answers).join(", ") : reply.action}` : "";
    push(callsign, q.to, { type: "answered", notify: { title: `${callsign} · ${reply ? "ответ принят" : "вопрос снят"}`, body: said, tag: id } });
    host().log({ ev: "answered", callsign, question: id, ...(reply ? { by: reply.by } : { cancelled: true }) });
    q.settle(reply);
  }

  /** Разбор ответа по виду вопроса: неверный вход — отказ словом, вопрос ждёт дальше. */
  function replyOf(q: Waiting, req: Frame, by: string): Reply {
    if (q.kind === "ask") {
      if (!isAnswers(req.answers)) throw refuse("bad_frame", "answer: answers — «текст вопроса → ответ»");
      return { by, answers: req.answers };
    }
    if (q.kind === "perm") {
      if (!isClient(by)) throw refuse("not_client", `${q.id}: разрешение решает человек, а не ${by || "отправитель без адреса"}`);
      if (req.action !== "allow" && req.action !== "deny") throw refuse("bad_frame", `answer: action ${String(req.action)} — allow или deny`);
      if (req.message !== undefined && typeof req.message !== "string") throw refuse("bad_frame", "answer: message — строка");
      return { by, action: req.action, always: req.always === true, ...(req.message ? { message: req.message as string } : {}) };
    }
    const action = String(req.action ?? "accept");
    if (!["accept", "decline", "cancel"].includes(action)) throw refuse("bad_frame", `answer: action ${action}`);
    if (req.content !== undefined && !isRecord(req.content)) throw refuse("bad_frame", "answer: content — объект формы");
    return { by, action, ...(req.content ? { content: req.content as Record<string, unknown> } : {}) };
  }

  return {
    decide: {
      async "*"(s, input, opts: DecideOpts): Promise<PermissionResult> {
        // режима не видно — спрашиваем человека, а не разрешаем сами
        if (s.field("mode") === NO_QUESTIONS) {
          host().log({ ev: "allow", callsign: s.info.callsign, tool: opts.tool, why: `режим ${NO_QUESTIONS}` });
          return { behavior: "allow", updatedInput: input };
        }
        const { toolUseID, suggestions, signal, blockedPath, title, description, displayName, decisionReason } = opts;
        const tool = String(opts.tool);
        const reply = await ask(s, toolUseID, "perm", { tool, input, title, description, displayName, reason: decisionReason, blockedPath, suggestions }, signal);
        if (!reply) return { behavior: "deny", message: "cancelled" };
        if (reply.action !== "allow") return { behavior: "deny", message: reply.message ? `${REFUSAL} Reason: ${reply.message}` : REFUSAL };
        // «всегда» — только то, что предложил сам SDK: своих правил клиент не шлёт
        const lasting = !reply.always ? undefined : tool === PLAN_TOOL ? KEEP_EDITING : suggestions;
        return { behavior: "allow", updatedInput: input, ...(lasting?.length ? { updatedPermissions: lasting as NonNullable<DecideOpts["suggestions"]> } : {}) };
      },
      async AskUserQuestion(s, input, opts: DecideOpts): Promise<PermissionResult> {
        const reply = await ask(s, opts.toolUseID, "ask", { questions: input.questions ?? [] }, opts.signal);
        return reply ? { behavior: "allow", updatedInput: { ...input, answers: reply.answers } } : { behavior: "deny", message: "cancelled" };
      },
    },
    async elicit(s, req: ElicitationRequest, opts): Promise<ElicitationResult> {
      const kind: Kind = req.mode === "url" ? "url" : "form";
      const shape = kind === "url" ? { url: req.url } : { schema: req.requestedSchema };
      const reply = await ask(s, opts.requestId, kind, { server: req.serverName, message: req.message, ...shape }, opts.signal);
      if (!reply) return { action: "cancel" };
      return { action: reply.action ?? "accept", ...(reply.content ? { content: reply.content } : {}) } as ElicitationResult;
    },
    requests: {
      answer(req, ctx) {
        const id = String(req.question);
        if (done.has(id)) throw refuse("already_answered", `${id}: на вопрос уже ответили`);
        const q = waiting.get(id);
        if (!q || q.s.info.callsign !== req.callsign) throw refuse("unknown_question", `${id}: ждущего вопроса ${String(req.callsign)} с таким id этот Host не знает`);
        close(id, replyOf(q, req, ctx.from ?? ""));
        return undefined;
      },
      "question.list"(req) {
        return [...waiting.values()].filter((q) => q.s.info.callsign === req.callsign).map((q) => ({ question: q.id, kind: q.kind, ...q.body }));
      },
    },
  };
}
