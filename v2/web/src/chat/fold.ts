// Свёртка разговора: сообщения SDK по порядку → строки ленты, карточки инструментов, задачи и состояние хода. Чистая функция: живое и история идут одним шагом; шаг на вид записи — своя функция.
import { duration, hhmm, LIMIT_NAMES, plural } from "../lib/time.ts";
import { API_ERRORS, FALLBACK_WHY, kilo, modelName, REFUSAL_AREAS, RESULT_ERRORS, TASK_END } from "./words.ts";

export type Msg = Record<string, any>;
export type Part = { k: "text"; text: string; live?: boolean } | { k: "think"; text: string; live?: boolean } | { k: "tool"; id: string };
export type Row =
  | { k: "me"; key: string; uuid?: string; text: string; pics: string[]; /** имена приложенных документов */ files?: string[]; /** кто написал: устройство человека; своё — без подписи */ from?: string; state?: MeState }
  | { k: "in"; key: string; via: "session" | "agent" | "owner" | "service"; from: string; tag?: string; text: string; at: string }
  | { k: "reply"; key: string; parts: Part[] }
  | { k: "cmd"; key: string; name: string; args: string; out?: string }
  | { k: "sys"; key: string; icon: string; text: string; tone?: "wait" | "swap"; retry?: boolean; boundary?: boolean }
  | { k: "line"; key: string; icon?: string; text: string; dim?: string; tone?: string; local?: boolean }
  | { k: "task"; key: string; id: string }
  | { k: "ban"; key: string; tone: "bad" | "wait"; icon?: string; title: string; body?: string; edit?: string; refusal?: boolean }
  | { k: "res"; key: string; bits: string[]; /** строка поставлена страницей: итога хода в записи не было */ synthetic?: boolean }
  | { k: "end"; key: string; text: string; why?: string }
  | { k: "sum"; key: string; stats: string; text: string };
/** Своё сообщение: sending — уходит; queued — ждёт в очереди сессии; sent — принято; taken — ход его взял; cancelled — снято с очереди; lost — не ушло. */
export type MeState = "sending" | "queued" | "sent" | "taken" | "cancelled" | "lost";
type Draft<T = Row> = T extends Row ? Omit<T, "key"> : never;
export type Tool = { id: string; name?: string; input?: Msg; result?: { text: string; pics: string[]; error: boolean }; note?: string; secs?: number; task?: string; steps: Row[] };
export type Task = { id: string; tool?: string; desc: string; type?: string; bg: boolean; summary?: string; last?: string; steps?: number; started: number; end?: string; final?: string };
export type Todo = { content: string; activeForm?: string; status: string };
export type View = {
  rows: Row[];
  tools: Record<string, Tool>;
  tasks: Record<string, Task>;
  todos?: Todo[];
  hint: string;
  compacting: boolean;
  thinking: number | null;
  model?: string;
  /** накопленная стоимость процесса: строка хода — разница */
  cost: number;
  /** ход прервал человек: его строка ошибки не показывается */
  interrupted: boolean;
  /** статусы сообщений по номеру: что сказал Host */
  status: Record<string, MeState>;
  /** идущие сообщения: родитель (пусто — лента) → id */
  stream: Record<string, string>;
  replies: Map<string, Extract<Row, { k: "reply" }>>;
  /** запись, которую сворачиваем сейчас, и сколько строк она уже дала */
  at?: string;
  sub: number;
  n: number;
};

const TAGGED = /^\s*<(fleet-message|fleet-question|cross-session-message|agent-message)\b([^>]*)>\n?([\s\S]*?)\n?<\/\1>(?:\n\(Задача от родителя[^\n]*\))?\s*$/;
const COMMAND = /<command-name>\s*([^<]*?)\s*<\/command-name>|<command-message>\s*([^<]*?)\s*<\/command-message>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const STDOUT = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const STDERR = /^\s*<local-command-stderr>/;
const TASK_TEXT = /^\s*<task-notification>/;
const INTERRUPT = /^\[Request interrupted by user/;
const SERVICE = /^\s*(<system-reminder>[\s\S]*<\/system-reminder>\s*$|Caveat:)/;
const NO_STATS = "контекст сжат";

/** Ключ строки — от её записи: страница «Раньше» и история не сдвигают раскрытое; запись без uuid — по порядку. */
const push = (v: View, r: Draft, list: Row[] = v.rows) => void list.push({ key: v.at ? `${v.at}:${v.sub++}` : `r${++v.n}`, ...r } as Row);
const ban = (v: View, tone: "bad" | "wait", title: string, body?: string, icon?: string) => push(v, { k: "ban", tone, title, ...(body ? { body } : {}), ...(icon ? { icon } : {}) });
const bad = (v: View, body: string) => ban(v, "bad", "Ошибка", body);
const line = (v: View, text: string, icon: string, tone?: string) => push(v, { k: "line", text, icon, ...(tone ? { tone } : {}) });
const sentence = (...bits: unknown[]) => bits.filter(Boolean).join(". ");
const area = (category: unknown) => (category ? `Область: ${REFUSAL_AREAS[String(category)] ?? String(category)}` : "");
const timeOf = (m: Msg) => (m.timestamp ? hhmm(new Date(m.timestamp)) : "");
const toolOf = (v: View, id: string): Tool => (v.tools[id] ??= { id, steps: [] });
/** Куда идёт строка: шаг субагента — в его карточку, остальное — в ленту. */
const listOf = (v: View, parent?: string | null): Row[] => (parent ? toolOf(v, parent).steps : v.rows);
export const taskIcon = (type?: string) => (type === "local_agent" ? "bot" : "terminal");

function replyOf(v: View, list: Row[], id: string) {
  let r = v.replies.get(id);
  if (!r) {
    r = { k: "reply", key: id, parts: [] };
    list.push(r);
    v.replies.set(id, r);
  }
  return r;
}
const dropLive = (r: { parts: Part[] }) => void (r.parts = r.parts.filter((p) => !("live" in p && p.live)));

/** Картинка с настоящими данными: адрес снаружи и обрезанное в журнале не показываются. */
const picsOf = (blocks: Msg[]): string[] => blocks.filter((b) => b.type === "image" && b.source?.type === "base64" && !String(b.source.data).endsWith("…")).map((b) => `data:${b.source.media_type};base64,${b.source.data}`);

function resultParts(content: unknown) {
  if (typeof content === "string") return { text: content, pics: [] };
  if (!Array.isArray(content)) return { text: content === undefined || content === null ? "" : JSON.stringify(content), pics: [] };
  const blocks = content as Msg[];
  return { text: blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n"), pics: picsOf(blocks) };
}

function block(v: View, list: Row[], id: string, m: Msg, b: Msg) {
  if (b.type === "text") {
    if (typeof b.text === "string" && b.text.trim()) replyOf(v, list, id).parts.push({ k: "text", text: b.text });
  } else if (b.type === "thinking" || b.type === "redacted_thinking") {
    const { parts } = replyOf(v, list, id);
    const last = parts.at(-1);
    if (last?.k === "think") last.text += String(b.thinking ?? "");
    else parts.push({ k: "think", text: String(b.thinking ?? "") });
  } else if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") {
    const tool = toolOf(v, b.id);
    tool.name = b.name;
    tool.input = b.input ?? {};
    if (b.name === "TodoWrite" && !m.parent_tool_use_id) v.todos = (b.input?.todos as Todo[]) ?? [];
    replyOf(v, list, id).parts.push({ k: "tool", id: b.id });
  }
}

function assistant(v: View, m: Msg) {
  const msg = m.message ?? {};
  v.hint = "";
  v.thinking = null;
  if (typeof msg.model === "string" && !m.parent_tool_use_id) v.model = msg.model;
  const list = listOf(v, m.parent_tool_use_id);
  const id: string = msg.id ?? m.uuid;
  const found = v.replies.get(id);
  if (found) dropLive(found);
  for (const b of (Array.isArray(msg.content) ? msg.content : []) as Msg[]) block(v, list, id, m, b);
  if (m.parent_tool_use_id) return;
  if (msg.stop_reason === "refusal" && m.isApiErrorMessage) {
    const last = v.rows.at(-1);
    if (!(last?.k === "ban" && last.refusal)) push(v, { k: "ban", tone: "bad", icon: "shield-off", title: `${modelName(msg.model)} отказалась отвечать`, refusal: true, body: area(msg.stop_details?.category) });
  } else if (m.error) bad(v, API_ERRORS[m.error] ?? String(m.error));
}

function stream(v: View, m: Msg) {
  const parent: string = m.parent_tool_use_id ?? "";
  const e = m.event ?? {};
  if (e.type === "message_start") v.stream[parent] = e.message?.id;
  if (e.type !== "content_block_delta" || !v.stream[parent]) return;
  const k = e.delta?.type === "text_delta" ? "text" : e.delta?.type === "thinking_delta" ? "think" : null;
  if (!k) return;
  const add = String(k === "text" ? e.delta.text : e.delta.thinking);
  const { parts } = replyOf(v, listOf(v, parent), v.stream[parent]);
  const live = parts.findLast((p) => p.k === k && p.live);
  if (live && live.k !== "tool") live.text += add;
  else parts.push({ k, text: add, live: true });
}

/** Сводка сжатия: только суть, без служебных вставок и обёртки. */
function summaryText(text: string) {
  const body = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");
  const at = body.indexOf("Summary:\n");
  return (at >= 0 ? body.slice(at + "Summary:\n".length) : body).replace(/\n(If you need specific details|Please continue|Continue the conversation)[\s\S]*$/, "").trim();
}

function summary(v: View, text: string) {
  const stats = v.rows.findLast((r) => r.k === "sys" && r.boundary);
  if (stats?.k === "sys") v.rows[v.rows.lastIndexOf(stats)] = { k: "sum", key: stats.key, stats: stats.text, text: summaryText(text) };
  else push(v, { k: "sum", stats: NO_STATS, text: summaryText(text) });
}

function tagged(v: View, m: Msg, [, tag, attrs, inner]: RegExpExecArray) {
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
  const mode = attr("from-mode");
  const text = tag === "fleet-question" ? inner.replace(/\n?Ответь инструментом fleet\.answer:[^\n]*$/, "") : inner;
  push(v, { k: "in", via: tag === "agent-message" ? "agent" : "session", from: attr("from") ?? attr("from-name") ?? "", ...(mode && mode !== "default" ? { tag: mode } : {}), text, at: timeOf(m) });
}

/** Конец задачи: один раз на задачу, откуда бы ни пришёл. */
function endTask(v: View, id: string, status: string, summaryOf?: string) {
  const t = (v.tasks[id] ??= { id, desc: summaryOf ?? "", bg: false, started: Date.now() });
  if (t.end) return;
  t.end = status;
  t.final = summaryOf ?? t.final;
  const words = TASK_END[status];
  const at = t.tool ? -1 : v.rows.findIndex((r) => r.k === "task" && r.id === id);
  if (!words) {
    if (at >= 0) v.rows.splice(at, 1);
    return;
  }
  if (t.tool && !t.bg) return;
  const about = t.desc || summaryOf;
  const end: Draft = { k: "line", tone: words[1], icon: taskIcon(t.type), text: words[0], ...(about ? { dim: ` · ${about}` } : {}) };
  if (at >= 0) v.rows[at] = { key: v.rows[at].key, ...end } as Row;
  else push(v, end);
}

/** Команда разговора; свой пузырь той же команды исчезает, вывод, пришедший раньше имени, — в её строке. */
function command(v: View, text: string, found: RegExpExecArray) {
  const raw = found[1] ?? found[2];
  const name = raw.startsWith("/") ? raw : `/${raw}`;
  const last = v.rows.at(-1);
  const out = last?.k === "line" && last.local ? last.text : undefined;
  if (out !== undefined) v.rows.pop();
  const prev = v.rows.at(-1);
  if (prev?.k === "me" && prev.text.trim() === name) v.rows.pop();
  push(v, { k: "cmd", name, args: ARGS.exec(text)?.[1]?.trim() ?? "", ...(out !== undefined ? { out } : {}) });
}

/** Новый ввод после ответа без строки итога — прошлый ход кончился: история разговора итогов хода не хранит. */
function closeTurn(v: View) {
  for (let i = v.rows.length - 1; i >= 0; i--) {
    const r = v.rows[i]!;
    if (r.k === "res" || r.k === "end" || r.k === "me" || r.k === "in" || (r.k === "sys" && r.tone === "wait" && r.icon === "square")) return;
    if (r.k === "reply") return push(v, { k: "res", bits: ["ход закончен"], synthetic: true });
  }
}

function text(v: View, m: Msg, body: string, pics: string[]) {
  if (m.isSynthetic || m.isMeta || SERVICE.test(body) || STDERR.test(body)) return;
  if (INTERRUPT.test(body)) {
    const at = timeOf(m) || (m._at ? hhmm(m._at) : "");
    v.interrupted = true;
    return push(v, { k: "sys", tone: "wait", icon: "square", text: at ? `прервано · ${at}` : "прервано" });
  }
  const name = COMMAND.exec(body);
  if (name) return command(v, body, name);
  const out = STDOUT.exec(body);
  if (out) {
    const last = v.rows.findLast((r) => r.k === "cmd");
    if (last?.k === "cmd") last.out = out[1];
    return;
  }
  if (TASK_TEXT.test(body)) {
    const tag = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(body)?.[1];
    return endTask(v, tag("task-id") ?? "", tag("status") ?? "", tag("summary"));
  }
  // сообщение службы или машины без обёртки: показывается с отправителем
  if (typeof m.from === "string" && /^[.@]/.test(m.from)) {
    closeTurn(v);
    return push(v, { k: "in", via: "service", from: m.from, text: body, at: timeOf(m) });
  }
  if (m.origin?.kind === "peer") {
    closeTurn(v);
    const mode = m.origin.fromMode;
    return push(v, { k: "in", via: "session", from: m.origin.name ?? m.origin.from ?? "", ...(mode && mode !== "default" ? { tag: mode } : {}), text: body, at: timeOf(m) });
  }
  // сообщение в очереди ждёт конца идущего хода: прошлый ход им не закрывается
  const known = typeof m.uuid === "string" ? v.status[m.uuid] : undefined;
  const state: MeState | undefined = known ?? (m._local ? ((m._state as MeState | undefined) ?? (m._queued ? "queued" : "sent")) : undefined);
  if (state !== "queued" && state !== "cancelled") closeTurn(v);
  const content = m.message?.content;
  const docs = Array.isArray(content) ? (content as Msg[]).filter((b) => b.type === "document").map((b) => String(b.title ?? "документ")) : [];
  const files = [...docs, ...((m._files as string[] | undefined) ?? [])];
  push(v, { k: "me", uuid: m.uuid, text: body, pics, ...(files.length ? { files } : {}), ...(typeof m.from === "string" ? { from: m.from } : {}), ...(state ? { state } : {}) });
}

function user(v: View, m: Msg) {
  const content = m.message?.content;
  const blocks: Msg[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  for (const b of blocks) if (b.type === "tool_result") toolOf(v, b.tool_use_id).result = { ...resultParts(b.content), error: !!b.is_error };
  const body = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
  const pics = picsOf(blocks);
  const attached = blocks.some((b) => b.type === "document") || !!(m._files as unknown[] | undefined)?.length;
  if (m.parent_tool_use_id || (!body.trim() && !pics.length && !attached)) return;
  v.hint = "";
  if (m.isCompactSummary) return summary(v, body);
  const peer = TAGGED.exec(body);
  if (peer) return (closeTurn(v), tagged(v, m, peer));
  text(v, m, body, pics);
}

function result(v: View, m: Msg) {
  for (const [parent, id] of Object.entries(v.stream)) {
    const r = v.replies.get(id);
    if (r) r.parts = r.parts.map((p) => (p.k === "tool" ? p : { ...p, live: false }));
    delete v.stream[parent];
  }
  v.compacting = false;
  v.thinking = null;
  // ход кончился — свои сообщения из очереди ушли в сессию (про чужие и про отменённые скажет статус Host)
  for (const r of v.rows) if (r.k === "me" && r.state === "queued" && (!r.uuid || !v.status[r.uuid])) r.state = "sent";
  const was = v.interrupted;
  v.interrupted = false;
  const total = typeof m.total_cost_usd === "number" ? (m.total_cost_usd as number) : null;
  const cost = total === null ? null : total >= v.cost ? total - v.cost : total;
  if (total !== null) v.cost = total;
  if (m.is_error) {
    if (was) return;
    const why = m.result || (m.errors as string[] | undefined)?.join("; ");
    return push(v, { k: "end", text: `ход оборвался: ${RESULT_ERRORS[m.subtype] ?? m.subtype ?? "ошибка"}`, ...(why ? { why } : {}) });
  }
  const usage = m.usage ?? {};
  const inContext = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const steps = m.num_turns ? `${m.num_turns} ${plural(m.num_turns, "шаг", "шага", "шагов")}` : "";
  const bits = ["ход закончен", m.duration_ms ? duration(m.duration_ms) : "", steps, cost !== null ? `$${cost.toFixed(2).replace(".", ",")}` : "", inContext ? `${kilo(inContext)} в контексте` : ""];
  push(v, { k: "res", bits: bits.filter(Boolean) });
}

function rateLimit(v: View, m: Msg) {
  const info = m.rate_limit_info ?? {};
  if (info.status !== "allowed_warning" && info.status !== "rejected") return;
  const name = LIMIT_NAMES[info.rateLimitType] ?? info.rateLimitType;
  const body = name ? `${name}${info.resetsAt ? `, сброс в ${hhmm(info.resetsAt * 1000)}` : ""}` : "";
  ban(v, "wait", info.status === "rejected" ? "Лимит подписки исчерпан" : "Лимит подписки скоро кончится", body, "gauge");
}

function compactStats(m: Msg) {
  const meta = m.compact_metadata ?? {};
  const { pre_tokens: pre, post_tokens: post } = meta;
  return `${NO_STATS}${pre ? ` · ${kilo(pre)}` : ""}${pre && post ? ` → ${kilo(post)}` : ""}`;
}

function refusalFallback(v: View, m: Msg) {
  const now = modelName(m.fallback_model);
  ban(v, "wait", `${modelName(m.original_model)} отказалась — ответ переписан моделью ${now}`, [m.scope === "local" ? "Только этот ответ: модель сессии прежняя." : `Дальше сессия идёт на ${now}.`, sentence(area(m.api_refusal_category), m.api_refusal_explanation)].filter(Boolean).join(" "), "shield-off");
}

function refusalEnd(v: View, m: Msg) {
  const refused = v.rows.findLast((r) => r.k === "ban" && r.refusal);
  const asked = v.rows.find((r) => r.k === "me" && r.uuid === m.refused_user_message_uuid);
  const edit = asked?.k === "me" ? asked.text : undefined;
  const why = sentence(area(m.api_refusal_category), m.api_refusal_explanation);
  if (refused?.k === "ban") {
    refused.body = sentence(refused.body, m.api_refusal_explanation) || why;
    refused.edit = edit;
  } else push(v, { k: "ban", tone: "bad", icon: "shield-off", title: `${modelName(m.original_model)} отказалась отвечать`, refusal: true, body: why, edit });
}

function taskStarted(v: View, m: Msg) {
  const id = m.task_id as string;
  v.tasks[id] = { id, tool: m.tool_use_id, desc: m.description ?? "", type: m.task_type, bg: !!m.is_backgrounded, started: m.timestamp ? new Date(m.timestamp).getTime() : (m._at ?? Date.now()) };
  if (m.tool_use_id) toolOf(v, m.tool_use_id).task = id;
  else push(v, { k: "task", id });
}

/** Шаг системной записи: таблица по subtype, незнакомая не рисуется. */
const SYSTEM: Record<string, (v: View, m: Msg) => void> = {
  init(v, m) {
    const strip = (x: unknown) => String(x).replace(/\[.*$/, "");
    if (v.model && m.model && strip(v.model) !== strip(m.model)) push(v, { k: "sys", icon: "sparkles", text: `модель: ${modelName(v.model)} → ${modelName(m.model)}` });
    v.model = m.model ?? v.model;
  },
  session_state_changed(v, m) {
    if (m.state === "idle") v.thinking = null;
  },
  thinking_tokens(v, m) {
    v.thinking = m.estimated_tokens ?? null;
  },
  status(v, m) {
    v.compacting = m.status === "compacting";
    if (m.compact_result === "failed") bad(v, `Сжать контекст не вышло${m.compact_error ? `: ${m.compact_error}` : ""}`);
  },
  compact_boundary(v, m) {
    v.compacting = false;
    const last = v.rows.at(-1);
    if (last?.k === "sum" && last.stats === NO_STATS) last.stats = compactStats(m);
    else push(v, { k: "sys", icon: "archive", text: compactStats(m), boundary: true });
  },
  api_retry(v, m) {
    const last = v.rows.at(-1);
    if (last?.k === "sys" && last.retry) v.rows.pop();
    const bits = [`повтор запроса к API · ${m.attempt} из ${m.max_retries}`, m.error ?? m.error_status, m.retry_delay_ms ? `через ${Math.round(m.retry_delay_ms / 1000)} с` : ""];
    push(v, { k: "sys", tone: "wait", icon: "refresh-cw", text: bits.filter(Boolean).join(" · "), retry: true });
  },
  model_refusal_fallback: refusalFallback,
  model_refusal_no_fallback: refusalEnd,
  model_fallback(v, m) {
    const why = (FALLBACK_WHY[m.trigger] ?? "{m} не ответила").replace("{m}", modelName(m.original_model));
    ban(v, "wait", `${why} — этот ход отвечает ${modelName(m.fallback_model)}`, undefined, "shuffle");
  },
  hook_response(v, m) {
    if (m.outcome ? m.outcome === "success" : !m.exit_code) return;
    const why = String(m.stderr || m.output || "").slice(0, 300);
    push(v, { k: "line", tone: "wait", icon: "anchor", text: `Хук ${m.hook_name} не сработал${m.exit_code != null ? ` (код ${m.exit_code})` : ""}`, ...(why ? { dim: `: ${why}` } : {}) });
  },
  memory_recall(v, m) {
    const names = ((m.memories ?? []) as Msg[]).map((x) => String(x.path).split(/[\\/]/).pop());
    if (names.length) line(v, `Из памяти: ${names.join(", ")}`, "book-open");
  },
  informational(v, m) {
    if (m.level === "warning") ban(v, "wait", String(m.content));
    else line(v, String(m.content), "info");
  },
  notification(v, m) {
    if (m.priority === "high" || m.priority === "immediate") ban(v, "wait", String(m.text));
    else line(v, String(m.text), "info");
  },
  permission_denied(v, m) {
    line(v, `Отклонено правилами: ${m.tool_name}${m.message ? ` — ${m.message}` : ""}`, "ban");
  },
  files_persisted(v, m) {
    const saved = ((m.files ?? []) as Msg[]).map((f) => f.filename).join(", ");
    const failed = ((m.failed ?? []) as Msg[]).map((f) => `${f.filename}: ${f.error}`).join(", ");
    const said = [saved && `Файлы сохранены: ${saved}`, failed && `Не сохранились: ${failed}`].filter(Boolean).join(" · ");
    if (said) line(v, said, "file-up", failed ? "bad" : undefined);
  },
  local_command_output(v, m) {
    const said = String(m.content ?? "").trim();
    const last = v.rows.at(-1);
    if (last?.k === "cmd" && last.out === undefined) last.out = said;
    else push(v, { k: "line", icon: "zap", text: said, local: true });
  },
  mirror_error(v, m) {
    if (m.error) bad(v, String(m.error));
  },
  plugin_install(v, m) {
    if (m.status === "failed") bad(v, `Плагин не установился${m.name ? ` (${m.name})` : ""}${m.error ? `: ${m.error}` : ""}`);
  },
  task_started: taskStarted,
  task_progress(v, m) {
    const t = v.tasks[m.task_id];
    if (!t) return;
    t.summary = m.summary ?? t.summary;
    t.last = m.last_tool_name ?? t.last;
    t.steps = m.usage?.tool_uses ?? t.steps;
  },
  task_updated(v, m) {
    const t = v.tasks[m.task_id];
    const p = m.patch ?? {};
    if (!t) return;
    if (typeof p.is_backgrounded === "boolean") t.bg = p.is_backgrounded;
    if (p.status && p.status !== "running" && p.status !== "pending") endTask(v, t.id, p.status);
  },
  task_notification(v, m) {
    endTask(v, m.task_id, m.status, m.summary);
  },
  /** Набор фоновых задач от SDK: кого нет в наборе, те кончились. */
  background_tasks_changed(v, m) {
    const set = (m.tasks ?? []) as Msg[];
    for (const x of set) {
      const known = v.tasks[x.task_id];
      if (known) known.bg = true;
      else v.tasks[x.task_id] = { id: x.task_id, desc: x.description ?? "", type: x.task_type, bg: true, started: Date.now() };
    }
    for (const t of Object.values(v.tasks)) if (t.bg && !t.end && !set.some((x) => x.task_id === t.id)) endTask(v, t.id, "gone");
  },
};

/** Шаг записи: таблица по type. */
const STEP: Record<string, (v: View, m: Msg) => void> = {
  assistant,
  user,
  result,
  stream_event: stream,
  rate_limit_event: rateLimit,
  system: (v, m) => SYSTEM[m.subtype]?.(v, m),
  auth_status: (v, m) => void (m.error && bad(v, String(m.error))),
  tool_progress: (v, m) => void (v.tools[m.tool_use_id] && (v.tools[m.tool_use_id].secs = m.elapsed_time_seconds)),
  tool_use_summary(v, m) {
    for (const id of (m.preceding_tool_use_ids ?? []) as string[]) toolOf(v, id).note = m.summary;
  },
  prompt_suggestion: (v, m) => void (v.hint = m.suggestion ?? ""),
  conversation_reset: (v) => push(v, { k: "sys", icon: "rotate-ccw", text: "разговор начат заново" }),
  /** Статус своего сообщения от Host: в очереди, взято ходом, отменено. Строка «ход закончен», поставленная перед сообщением из очереди, снимается: ход ещё идёт. */
  "message.status"(v, m) {
    const state: MeState = m.status === "taken" ? "taken" : m.status === "cancelled" ? "cancelled" : "queued";
    v.status[m.uuid] = state;
    const at = v.rows.findIndex((r) => r.k === "me" && r.uuid === m.uuid);
    if (at < 0) return;
    (v.rows[at] as Extract<Row, { k: "me" }>).state = state;
    const before = v.rows[at - 1];
    if (state === "queued" && before?.k === "res" && before.synthetic) v.rows.splice(at - 1, 1);
  },
  /** Свои строки страницы: сообщение сессии владельцу и смена аккаунта. */
  owner: (v, m) => push(v, { k: "in", via: "owner", from: m.from, ...(m.tag ? { tag: m.tag } : {}), text: m.text, at: timeOf(m) }),
  account: (v, m) => push(v, { k: "sys", tone: "swap", icon: "arrow-left-right", text: `аккаунт: ${m.from} → ${m.to}` }),
};

export function fold(msgs: readonly Msg[]): View {
  const v: View = { rows: [], tools: {}, tasks: {}, hint: "", compacting: false, thinking: null, cost: 0, interrupted: false, status: {}, stream: {}, replies: new Map(), sub: 0, n: 0 };
  const seen = new Set<string>(msgs.flatMap((m) => (m.subtype === "model_refusal_fallback" ? (m.retracted_message_uuids ?? []) : [])));
  for (const m of msgs) {
    // статус сообщения несёт номер самого сообщения: повтором записи он не считается
    if (typeof m.uuid === "string" && m.type !== "message.status") {
      if (seen.has(m.uuid)) continue;
      seen.add(m.uuid);
    }
    v.at = typeof m.uuid === "string" && m.type !== "message.status" ? m.uuid : undefined;
    v.sub = 0;
    STEP[m.type]?.(v, m);
  }
  return v;
}

/** Список дел: сколько готово из скольких. */
export const todoProgress = (todos: readonly Todo[]) => ({ done: todos.filter((t) => t.status === "completed").length, of: todos.length });

/** Задачи в фоне: идут и ушли в фон. */
export const backgrounded = (v: View) => Object.values(v.tasks).filter((t) => t.bg && !t.end);
