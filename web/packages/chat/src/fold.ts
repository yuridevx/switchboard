// Журнал разговора → строки ленты. Чистая функция: одно сообщение — один шаг step; живая пачка идёт тем же шагом, что и свёртка истории заново.
// Строка — данные, посчитанные здесь: вид только рисует. Шаг правит переданный объект: на странице это черновик стора.
import { duration, hhmm, LIMIT_NAMES, plural } from "@switchboard/web-ui";
import { API_ERRORS, FALLBACK_WHY, kilo, modelName, REFUSAL_AREAS, RESULT_ERRORS, TASK_END } from "./words.ts";

export type Msg = Record<string, any>;

export type Part = { t: "text"; text: string; live?: boolean; u?: string } | { t: "think"; text: string; live?: boolean; u?: string } | { t: "tool"; id: string; u?: string };
export type Tone = "ok" | "bad" | "wait" | "swap" | "run";
export type Row =
  | { k: "me"; id: string; text: string; pics: string[]; files: string[]; at: string }
  | { k: "in"; id: string; via: "session" | "agent" | "owner"; from: string; tag?: string; text: string; at: string }
  | { k: "reply"; id: string; parts: Part[] }
  | { k: "ban"; id: string; tone: "bad" | "wait"; icon?: string; title: string; body?: string; edit?: string; refusal?: boolean }
  | { k: "sys"; id: string; tone?: Tone; icon?: string; text: string; retry?: boolean; boundary?: boolean }
  | { k: "line"; id: string; tone?: Tone; icon?: string; text: string; dim?: string; local?: boolean }
  | { k: "task"; id: string }
  | { k: "cmd"; id: string; name: string; args: string; out?: string }
  | { k: "sum"; id: string; stats: string; text: string }
  | { k: "res"; id: string; bits: string[] }
  | { k: "end"; id: string; text: string; why?: string };

export type Tool = {
  id: string;
  name?: string;
  input?: Msg;
  result?: { text: string; pics: string[]; error: boolean; raw?: unknown };
  task?: string;
  note?: string;
  secs?: number;
  steps: Row[];
};
export type Task = { id: string; tool?: string; desc: string; type?: string; bg: boolean; summary?: string; last?: string; steps?: number; started: number; end?: string; final?: string };
export type Todo = { content: string; activeForm?: string; status: string };

export type View = {
  rows: Row[];
  tools: Record<string, Tool>;
  tasks: Record<string, Task>;
  todos: Todo[] | null;
  /** последняя известная модель сессии */
  model: string | null;
  /** накопленная стоимость процесса: строка хода — разница */
  cost: number;
  /** ход прервал человек: его строка ошибки не показывается */
  interrupted: boolean;
  compacting: boolean;
  thinking: number | null;
  suggestion: string;
  /** идущие сообщения: родитель (пусто — лента) → id */
  stream: Record<string, string>;
  n: number;
};

export const emptyView = (): View => ({ rows: [], tools: {}, tasks: {}, todos: null, model: null, cost: 0, interrupted: false, compacting: false, thinking: null, suggestion: "", stream: {}, n: 0 });

/** Поле сообщения: SDK пишет змеиным регистром, файл разговора — верблюжьим. */
function field(m: Msg, snake: string): any {
  return m[snake] ?? m[snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())];
}

const nextId = (v: View) => `r${++v.n}`;
const idOf = (v: View, m: Msg) => (typeof m.uuid === "string" ? m.uuid : nextId(v));
const timeOf = (m: Msg) => (m.timestamp ? hhmm(new Date(m.timestamp)) : "");

function toolOf(v: View, id: string): Tool {
  return (v.tools[id] ??= { id, steps: [] });
}
/** Куда идёт строка: шаг субагента — в его карточку, остальное — в ленту. */
const listOf = (v: View, m: Msg): Row[] => (m.parent_tool_use_id ? toolOf(v, m.parent_tool_use_id).steps : v.rows);

const ban = (v: View, m: Msg, tone: "bad" | "wait", title: string, body?: string, icon?: string) => void v.rows.push({ k: "ban", id: idOf(v, m), tone, title, ...(body ? { body } : {}), ...(icon ? { icon } : {}) });
const bad = (v: View, m: Msg, body: string) => ban(v, m, "bad", "Ошибка", body);
const line = (v: View, m: Msg, text: string, tone?: Tone, icon?: string) => void v.rows.push({ k: "line", id: idOf(v, m), text, ...(tone ? { tone } : {}), ...(icon ? { icon } : {}) });

function findReply(list: Row[], id: string) {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.k === "reply" && r.id === id) return r;
  }
  return null;
}

function replyOf(list: Row[], id: string) {
  let r = findReply(list, id);
  if (!r) list.push((r = { k: "reply", id, parts: [] }));
  return r;
}

const dropLive = (r: { parts: Part[] }) => void (r.parts = r.parts.filter((p) => !("live" in p && p.live)));

const area = (category: unknown) => (category ? `Область: ${REFUSAL_AREAS[String(category)] ?? String(category)}` : "");
const sentence = (...bits: unknown[]) => bits.filter(Boolean).join(". ");

function assistant(v: View, m: Msg) {
  const msg = m.message ?? {};
  v.suggestion = "";
  v.thinking = null;
  if (typeof msg.model === "string" && !m.parent_tool_use_id) v.model = msg.model;
  const list = listOf(v, m);
  const blocks: Msg[] = Array.isArray(msg.content) ? msg.content : [];
  const id = msg.id ?? idOf(v, m);
  const found = findReply(list, id);
  if (found) dropLive(found);
  for (const b of blocks) {
    if (b.type === "text") {
      if (typeof b.text === "string" && b.text.trim()) replyOf(list, id).parts.push({ t: "text", text: b.text, u: m.uuid });
    } else if (b.type === "thinking" || b.type === "redacted_thinking") {
      const parts = replyOf(list, id).parts;
      const last = parts.at(-1);
      const text = String(b.thinking ?? "");
      if (last?.t === "think") last.text += text;
      else parts.push({ t: "think", text, u: m.uuid });
    } else if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") {
      const tool = toolOf(v, b.id);
      tool.name = b.name;
      tool.input = b.input ?? {};
      if (b.name === "TodoWrite" && !m.parent_tool_use_id) v.todos = (b.input?.todos as Todo[]) ?? [];
      replyOf(list, id).parts.push({ t: "tool", id: b.id, u: m.uuid });
    }
  }
  if (m.parent_tool_use_id) return;
  if (msg.stop_reason === "refusal" && m.isApiErrorMessage) {
    const last = v.rows.at(-1);
    if (last?.k === "ban" && last.refusal) return;
    v.rows.push({ k: "ban", id: `ban-${id}`, tone: "bad", icon: "shield-off", title: `${modelName(msg.model)} отказалась отвечать`, refusal: true, body: area(msg.stop_details?.category) });
  } else if (m.error) {
    v.rows.push({ k: "ban", id: `ban-${id}`, tone: "bad", title: "Ошибка", body: API_ERRORS[m.error] ?? String(m.error) });
  }
}

function resultParts(content: unknown) {
  if (typeof content === "string") return { text: content, pics: [] };
  if (!Array.isArray(content)) return { text: content === undefined || content === null ? "" : JSON.stringify(content), pics: [] };
  const blocks = content as Msg[];
  return { text: blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n"), pics: picsOf(blocks) };
}

/** Картинка с настоящими данными: адрес снаружи и обрезанное в журнале не показываются. */
function picsOf(blocks: Msg[]): string[] {
  return blocks.filter((b) => b.type === "image" && b.source?.type === "base64" && !String(b.source.data).endsWith("…")).map((b) => `data:${b.source.media_type};base64,${b.source.data}`);
}

/** Теги сообщений не от человека. */
const TAGGED = /^\s*<(fleet-message|fleet-question|cross-session-message|agent-message)\b([^>]*)>\n?([\s\S]*?)\n?<\/\1>\s*$/;
const COMMAND = /<command-name>\s*([^<]*?)\s*<\/command-name>|<command-message>\s*([^<]*?)\s*<\/command-message>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const STDOUT = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const STDERR = /^\s*<local-command-stderr>/;
const TASK_TEXT = /^\s*<task-notification>/;
const INTERRUPT = /^\[Request interrupted by user/;
const SERVICE = /^\s*(<system-reminder>[\s\S]*<\/system-reminder>\s*$|Caveat:)/;

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/** Сводка сжатия: только суть, без служебных вставок и обёртки. */
function summaryText(text: string) {
  const body = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");
  const at = body.indexOf("Summary:\n");
  return (at >= 0 ? body.slice(at + "Summary:\n".length) : body).replace(/\n(If you need specific details|Please continue|Continue the conversation)[\s\S]*$/, "").trim();
}

/** Конец задачи: один раз на задачу, откуда бы ни пришёл. */
function endTask(v: View, id: string, status: string, summary?: string) {
  const t = (v.tasks[id] ??= { id, desc: summary ?? "", bg: false, started: Date.now() });
  if (t.end) return;
  t.end = status;
  t.final = summary ?? t.final;
  const words = TASK_END[status];
  const row = t.tool ? -1 : v.rows.findIndex((r) => r.k === "task" && r.id === id);
  if (!words) {
    if (row >= 0) v.rows.splice(row, 1);
    return;
  }
  if (t.tool && !t.bg) return;
  const about = t.desc || summary;
  const end: Row = { k: "line", id: `end-${id}`, tone: words[1], icon: t.type === "local_agent" ? "bot" : "terminal", text: words[0], ...(about ? { dim: ` · ${about}` } : {}) };
  if (row >= 0) v.rows[row] = end;
  else v.rows.push(end);
}

function commandRow(v: View, m: Msg, text: string, found: RegExpExecArray) {
  const raw = found[1] ?? found[2];
  const name = raw.startsWith("/") ? raw : `/${raw}`;
  const row: Row = { k: "cmd", id: idOf(v, m), name, args: ARGS.exec(text)?.[1]?.trim() ?? "" };
  const last = v.rows.at(-1);
  // свой пузырь той же команды исчезает; вывод, пришедший раньше имени, — в её строке
  if (last?.k === "line" && last.local) {
    row.out = last.text;
    v.rows.pop();
  }
  const prev = v.rows.at(-1);
  if (prev?.k === "me" && prev.text.trim() === name) v.rows.pop();
  v.rows.push(row);
}

function user(v: View, m: Msg) {
  const content = m.message?.content;
  const blocks: Msg[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  for (const b of blocks) {
    if (b.type !== "tool_result") continue;
    const tool = toolOf(v, b.tool_use_id);
    tool.result = { ...resultParts(b.content), error: !!b.is_error, raw: b.content };
  }
  const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
  const pics = picsOf(blocks);
  const files: string[] = m.files ?? [];
  if (m.parent_tool_use_id || (!text.trim() && !pics.length && !files.length)) return;
  v.suggestion = "";

  if (m.isCompactSummary) {
    const stats = v.rows.findLast((r) => r.k === "sys" && r.boundary);
    const sum = summaryText(text);
    if (stats?.k === "sys") {
      const at = v.rows.lastIndexOf(stats);
      v.rows[at] = { k: "sum", id: stats.id, stats: stats.text, text: sum };
    } else v.rows.push({ k: "sum", id: idOf(v, m), stats: "контекст сжат", text: sum });
    return;
  }

  const tagged = TAGGED.exec(text);
  if (tagged) {
    const [, tag, attrs, inner] = tagged;
    const mode = attr(attrs, "from-mode");
    const body = tag === "fleet-question" ? inner.replace(/\n?Ответь инструментом fleet\.answer:[^\n]*$/, "") : inner;
    v.rows.push({ k: "in", id: idOf(v, m), via: tag === "agent-message" ? "agent" : "session", from: attr(attrs, "from") ?? attr(attrs, "from-name") ?? "", ...(mode && mode !== "default" ? { tag: mode } : {}), text: body, at: timeOf(m) });
    return;
  }
  if (m.isSynthetic || m.isMeta || SERVICE.test(text) || STDERR.test(text)) return;
  if (INTERRUPT.test(text)) {
    const at = timeOf(m) || (m.arrived ? hhmm(m.arrived) : "");
    v.interrupted = true;
    v.rows.push({ k: "sys", id: idOf(v, m), tone: "wait", icon: "stop", text: at ? `прервано · ${at}` : "прервано" });
    return;
  }
  const command = COMMAND.exec(text);
  if (command) return commandRow(v, m, text, command);
  const out = STDOUT.exec(text);
  if (out) {
    const last = v.rows.findLast((r) => r.k === "cmd");
    if (last?.k === "cmd") last.out = out[1];
    return;
  }
  if (TASK_TEXT.test(text)) {
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1];
    return endTask(v, tag("task-id") ?? "", tag("status") ?? "", tag("summary"));
  }
  if (m.origin?.kind === "peer") {
    const mode = m.origin.fromMode;
    v.rows.push({ k: "in", id: idOf(v, m), via: "session", from: m.origin.name ?? m.origin.from ?? "", ...(mode && mode !== "default" ? { tag: mode } : {}), text, at: timeOf(m) });
    return;
  }
  v.rows.push({ k: "me", id: idOf(v, m), text, pics, files, at: timeOf(m) });
}

function compactStats(m: Msg) {
  const meta = field(m, "compact_metadata") ?? {};
  const pre = field(meta, "pre_tokens");
  const post = field(meta, "post_tokens");
  return `контекст сжат${pre ? ` · ${kilo(pre)}` : ""}${pre && post ? ` → ${kilo(post)}` : ""}`;
}

function refusalFallback(v: View, m: Msg) {
  const gone = new Set<string>(field(m, "retracted_message_uuids") ?? []);
  if (gone.size) {
    for (const r of v.rows) if (r.k === "reply") r.parts = r.parts.filter((p) => !p.u || !gone.has(p.u));
    v.rows = v.rows.filter((r) => r.k !== "reply" || r.parts.length);
  }
  const was = modelName(field(m, "original_model"));
  const now = modelName(field(m, "fallback_model"));
  ban(v, m, "wait", `${was} отказалась — ответ переписан моделью ${now}`, [m.scope === "local" ? "Только этот ответ: модель сессии прежняя." : `Дальше сессия идёт на ${now}.`, sentence(area(field(m, "api_refusal_category")), field(m, "api_refusal_explanation"))].filter(Boolean).join(" "), "shield-off");
}

function refusalEnd(v: View, m: Msg) {
  const refused = v.rows.findLast((r) => r.k === "ban" && r.refusal);
  const why = sentence(area(field(m, "api_refusal_category")), field(m, "api_refusal_explanation"));
  const uuid = field(m, "refused_user_message_uuid");
  const asked = v.rows.find((r) => r.k === "me" && r.id === uuid);
  const edit = asked?.k === "me" ? asked.text : undefined;
  if (refused?.k === "ban") {
    refused.body = sentence(refused.body, field(m, "api_refusal_explanation")) || why;
    refused.edit = edit;
  } else v.rows.push({ k: "ban", id: idOf(v, m), tone: "bad", icon: "shield-off", title: `${modelName(field(m, "original_model"))} отказалась отвечать`, refusal: true, body: why, edit });
}

function taskStarted(v: View, m: Msg) {
  const id = m.task_id as string;
  const started = m.timestamp ? new Date(m.timestamp).getTime() : Date.now();
  v.tasks[id] = { id, tool: m.tool_use_id, desc: m.description ?? "", type: m.task_type, bg: !!m.is_backgrounded, started };
  if (m.tool_use_id) toolOf(v, m.tool_use_id).task = id;
  else v.rows.push({ k: "task", id });
}

const SYSTEM: Record<string, (v: View, m: Msg) => void> = {
  init(v, m) {
    const strip = (x: unknown) => String(x).replace(/\[.*$/, "");
    if (v.model && m.model && strip(v.model) !== strip(m.model)) v.rows.push({ k: "sys", id: idOf(v, m), icon: "model", text: `модель: ${modelName(v.model)} → ${modelName(m.model)}` });
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
    if (m.compact_result === "failed") bad(v, m, `Сжать контекст не вышло${m.compact_error ? `: ${m.compact_error}` : ""}`);
  },
  compact_boundary(v, m) {
    v.compacting = false;
    const last = v.rows.at(-1);
    // сводка пришла раньше своей границы: числа — на её строке
    if (last?.k === "sum") last.stats = compactStats(m);
    else v.rows.push({ k: "sys", id: idOf(v, m), icon: "archive", text: compactStats(m), boundary: true });
  },
  api_retry(v, m) {
    const last = v.rows.at(-1);
    if (last?.k === "sys" && last.retry) v.rows.pop();
    const bits = [`повтор запроса к API · ${m.attempt} из ${m.max_retries}`, m.error ?? m.error_status, m.retry_delay_ms ? `через ${Math.round(m.retry_delay_ms / 1000)} с` : ""];
    v.rows.push({ k: "sys", id: idOf(v, m), tone: "wait", icon: "refresh-cw", text: bits.filter(Boolean).join(" · "), retry: true });
  },
  model_refusal_fallback: refusalFallback,
  model_refusal_no_fallback: refusalEnd,
  model_fallback(v, m) {
    const was = modelName(field(m, "original_model"));
    const why = (FALLBACK_WHY[m.trigger] ?? "{m} не ответила").replace("{m}", was);
    ban(v, m, "wait", `${why} — этот ход отвечает ${modelName(field(m, "fallback_model"))}`, undefined, "shuffle");
  },
  hook_response(v, m) {
    if (m.outcome ? m.outcome === "success" : !m.exit_code) return;
    const why = String(m.stderr || m.output || "").slice(0, 300);
    v.rows.push({ k: "line", id: idOf(v, m), tone: "wait", icon: "anchor", text: `Хук ${m.hook_name} не сработал${m.exit_code != null ? ` (код ${m.exit_code})` : ""}`, ...(why ? { dim: `: ${why}` } : {}) });
  },
  memory_recall(v, m) {
    const names = ((m.memories ?? []) as Msg[]).map((x) => String(x.path).split(/[\\/]/).pop());
    if (names.length) line(v, m, `Из памяти: ${names.join(", ")}`, undefined, "memory");
  },
  informational(v, m) {
    if (m.level === "warning") ban(v, m, "wait", String(m.content));
    else line(v, m, String(m.content), undefined, "info");
  },
  notification(v, m) {
    if (m.priority === "high" || m.priority === "immediate") ban(v, m, "wait", String(m.text));
    else line(v, m, String(m.text), undefined, "info");
  },
  permission_denied(v, m) {
    line(v, m, `Отклонено правилами: ${m.tool_name}${m.message ? ` — ${m.message}` : ""}`, undefined, "ban");
  },
  files_persisted(v, m) {
    const saved = ((m.files ?? []) as Msg[]).map((f) => f.filename).join(", ");
    const failed = ((m.failed ?? []) as Msg[]).map((f) => `${f.filename}: ${f.error}`).join(", ");
    const text = [saved && `Файлы сохранены: ${saved}`, failed && `Не сохранились: ${failed}`].filter(Boolean).join(" · ");
    if (text) line(v, m, text, failed ? "bad" : undefined, "file");
  },
  local_command_output(v, m) {
    const text = String(m.content ?? "").trim();
    const last = v.rows.at(-1);
    if (last?.k === "cmd" && last.out === undefined) last.out = text;
    else v.rows.push({ k: "line", id: idOf(v, m), icon: "zap", text, local: true });
  },
  mirror_error(v, m) {
    if (m.error) bad(v, m, String(m.error));
  },
  plugin_install(v, m) {
    if (m.status === "failed") bad(v, m, `Плагин не установился${m.name ? ` (${m.name})` : ""}${m.error ? `: ${m.error}` : ""}`);
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
    if (!t) return;
    const p = m.patch ?? {};
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
  /** Свои строки страницы: смена аккаунта сессии. */
  account_swap(v, m) {
    v.rows.push({ k: "sys", id: idOf(v, m), tone: "swap", icon: "arrow-left-right", text: `аккаунт: ${m.from} → ${m.to}` });
  },
};

function result(v: View, m: Msg) {
  v.thinking = null;
  v.compacting = false;
  for (const [parent, id] of Object.entries(v.stream)) {
    const r = findReply(parent ? toolOf(v, parent).steps : v.rows, id);
    if (r) r.parts = r.parts.map((p) => (p.t === "tool" ? p : { ...p, live: false }));
  }
  v.stream = {};
  const was = v.interrupted;
  v.interrupted = false;
  const total = typeof m.total_cost_usd === "number" ? (m.total_cost_usd as number) : null;
  const cost = total === null ? null : total >= v.cost ? total - v.cost : total;
  if (total !== null) v.cost = total;
  if (m.is_error) {
    if (was) return;
    const word = RESULT_ERRORS[m.subtype] ?? m.subtype ?? "ошибка";
    const why = m.result || (m.errors as string[] | undefined)?.join("; ");
    v.rows.push({ k: "end", id: idOf(v, m), text: `ход оборвался: ${word}`, ...(why ? { why } : {}) });
    return;
  }
  const usage = m.usage ?? {};
  const inContext = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const bits = ["ход закончен", m.duration_ms ? duration(m.duration_ms) : "", m.num_turns ? `${m.num_turns} ${plural(m.num_turns, "шаг", "шага", "шагов")}` : "", cost !== null ? `$${cost.toFixed(2).replace(".", ",")}` : "", inContext ? `${kilo(inContext)} в контексте` : ""];
  v.rows.push({ k: "res", id: idOf(v, m), bits: bits.filter(Boolean) });
}

function rateLimit(v: View, m: Msg) {
  const info = m.rate_limit_info ?? {};
  if (info.status !== "allowed_warning" && info.status !== "rejected") return;
  const name = LIMIT_NAMES[info.rateLimitType] ?? info.rateLimitType;
  const body = name ? `${name}${info.resetsAt ? `, сброс в ${hhmm(info.resetsAt * 1000)}` : ""}` : "";
  ban(v, m, "wait", info.status === "rejected" ? "Лимит подписки исчерпан" : "Лимит подписки скоро кончится", body, "gauge");
}

/** Кусочки идущего сообщения: одна запись на сообщение с накопленным текстом. */
function partial(v: View, m: Msg) {
  const parent = m.parent ?? "";
  const list = parent ? toolOf(v, parent).steps : v.rows;
  const r = replyOf(list, m.id);
  dropLive(r);
  if (m.think) r.parts.push({ t: "think", text: m.think, live: true });
  if (m.text) r.parts.push({ t: "text", text: m.text, live: true });
  v.stream[parent] = m.id;
}

/** Один шаг свёртки: правит v. */
export function step(v: View, m: Msg): void {
  switch (m.type) {
    case "assistant":
      return assistant(v, m);
    case "user":
      return user(v, m);
    case "result":
      return result(v, m);
    case "partial":
      return partial(v, m);
    case "system":
      return SYSTEM[m.subtype]?.(v, m);
    case "owner":
      v.rows.push({ k: "in", id: m.uuid, via: "owner", from: m.from, tag: m.tag, text: m.text, at: timeOf(m) });
      return;
    case "tool_use_summary":
      for (const id of (m.preceding_tool_use_ids ?? []) as string[]) toolOf(v, id).note = m.summary;
      return;
    case "tool_progress":
      if (v.tools[m.tool_use_id]) v.tools[m.tool_use_id].secs = m.elapsed_time_seconds;
      return;
    case "prompt_suggestion":
      v.suggestion = m.suggestion ?? "";
      return;
    case "rate_limit_event":
      return rateLimit(v, m);
    case "auth_status":
      if (m.error) bad(v, m, String(m.error));
      return;
    case "conversation_reset":
      v.rows.push({ k: "sys", id: idOf(v, m), icon: "reset", text: "разговор начат заново" });
      return;
  }
}

export function fold(log: Msg[]): View {
  const v = emptyView();
  for (const m of log) step(v, m);
  return v;
}

/** Задачи в фоне: идут и ушли в фон. */
export const backgrounded = (v: View) => Object.values(v.tasks).filter((t) => t.bg && !t.end);

