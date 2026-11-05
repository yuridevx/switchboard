// Свёртка разговора: сообщения SDK → строки ленты. Чистая функция, без рисования и сети: живая лента, история и её повтор идут одним кодом.
import { produce } from "immer";
import { LIMIT_NAMES } from "@switchboard/web-ui";
import { baseName, costText, kTokens, modelName, steps } from "./words.ts";

/** Сообщение SDK как есть: форму держит SDK, читаем только то, что показываем. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Msg = Record<string, any>;

export type Part =
  | { k: "text"; pid: string; uuid: string; text: string; live?: boolean }
  | { k: "think"; pid: string; uuid: string; text: string; live?: boolean }
  | { k: "tool"; pid: string; uuid: string; tool: string };

export type Tone = "ok" | "bad" | "wait" | "";

/** Значок служебной строки: имя, рисует вид. */
export type Icon = "archive" | "stop" | "retry" | "gauge" | "zap" | "x" | "model" | "info" | "ban" | "reset" | "shuffle" | "anchor" | "memory" | "file" | "swap";

export type Row =
  | { k: "reply"; id: string; parts: Part[] }
  | { k: "me"; id: string; uuid: string; text: string; pics: string[] }
  | { k: "in"; id: string; kind: "session" | "agent" | "owner"; name?: string; mode?: string; text: string; at?: number; push?: boolean }
  | { k: "cmd"; id: string; name: string; args: string; out: string }
  | { k: "sys"; id: string; icon: Icon; text: string; tone?: "wait" | "swap"; retry?: boolean }
  | { k: "sum"; id: string; pre?: number; post?: number; summary?: string; bound?: boolean }
  | { k: "res"; id: string; bits: string[] }
  | { k: "end"; id: string; text: string; err?: string }
  | { k: "line"; id: string; icon: Icon; text: string; dim?: string; tone: Tone }
  | { k: "task"; id: string; task: string }
  | { k: "ban"; id: string; icon: Icon; tone: "bad" | "wait"; title: string; body?: string; quiet?: boolean }
  | { k: "refusal"; id: string; from?: string; to?: string; local?: boolean; category?: string; text?: string; ask?: string };

export type ToolResult = { text: string; images: string[]; isError: boolean };

export type Tool = { id: string; name: string; input: Msg; steps: Row[]; result?: ToolResult; note?: string; task?: string; secs?: number; card: boolean };

export type Task = { id: string; desc: string; type: string; bg: boolean; tool?: string; summary?: string; lastTool?: string; uses?: number; status?: string; ended: boolean; startedAt?: number };

export type View = {
  rows: Row[];
  tools: Record<string, Tool>;
  tasks: Record<string, Task>;
  seen: Record<string, true>;
  /** последний id сообщения потока: у ленты и у каждого субагента свой */
  streams: Record<string, string>;
  /** ответы с живыми кусочками: конец хода их завершает */
  open: Array<{ parent: string; id: string }>;
  model?: string;
  cost: number;
  compacting: boolean;
  thinking: number;
  interrupted: boolean;
  hint: string;
  todo?: string;
  n: number;
};

export const emptyView = (): View => ({ rows: [], tools: {}, tasks: {}, seen: {}, streams: {}, open: [], cost: 0, compacting: false, thinking: 0, interrupted: false, hint: "", n: 0 });

/** Поле записи: живой кадр пишет снизу_вверх, файл разговора — верблюдом. */
function field(m: Msg, snake: string): unknown {
  if (m[snake] !== undefined) return m[snake];
  return m[snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
}

const nextId = (v: View) => `n${++v.n}`;
const sysId = (v: View, m: Msg) => (typeof m.uuid === "string" ? `s:${m.uuid}` : nextId(v));
const userId = (v: View, m: Msg) => (typeof m.uuid === "string" ? m.uuid : nextId(v));

/** Когда случилось: метка SDK или время прихода, которое ставит лента. */
const atOf = (m: Msg): number | undefined => (typeof m.timestamp === "string" ? Date.parse(m.timestamp) : (m._at as number | undefined));

/** Блок картинки → адрес data:; обрезанная или не base64 — пусто. */
function imageOf(b: Msg): string {
  const s: Msg | undefined = b.source;
  return s?.type === "base64" && typeof s.data === "string" && !s.data.includes("…") ? `data:${s.media_type};base64,${s.data}` : "";
}

const imagesOf = (blocks: Msg[]) => blocks.filter((b) => b?.type === "image").map(imageOf).filter(Boolean);

function blocksOf(content: unknown): Msg[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Msg[]) : [];
}

/** Где живут строки: лента или шаги инструмента-родителя; родителя нет — негде. */
function place(v: View, parent: unknown): Row[] | null {
  if (typeof parent !== "string" || !parent) return v.rows;
  return v.tools[parent]?.steps ?? null;
}

function toolOf(v: View, id: string): Tool {
  return (v.tools[id] ??= { id, name: "", input: {}, steps: [], card: false });
}

function replyIn(rows: Row[], id: string): Extract<Row, { k: "reply" }> {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.k === "reply" && r.id === id) return r;
  }
  const r: Row = { k: "reply", id, parts: [] };
  rows.push(r);
  return r;
}

// ───────────── ответ claude ─────────────

/** Ошибки ответа claude по-русски; незнакомая — как есть. */
const ERRORS: Record<string, string> = {
  authentication_failed: "Вход в claude не действует",
  billing_error: "Проблема с оплатой подписки",
  rate_limit: "Лимит подписки исчерпан",
  overloaded: "Серверы Anthropic перегружены",
  server_error: "Ошибка сервера Anthropic",
  invalid_request: "Запрос отклонён API",
  model_not_found: "Модель не найдена",
  max_output_tokens: "Ответ упёрся в предел длины",
  account_on_hold: "Аккаунт приостановлен",
  unknown: "Неизвестная ошибка API",
};

function banError(v: View, m: Msg, text: string): void {
  v.rows.push({ k: "ban", id: sysId(v, m), icon: "x", tone: "bad", title: "Ошибка", body: text });
}

/** Отказ модели: ответ-ошибка и событие claude об одном отказе — одной плашкой; пришедшее позже дополняет. */
function addRefusal(v: View, m: Msg, r: { from?: string; to?: string; local?: boolean; category?: string; text?: string; ask?: string }): void {
  for (let i = v.rows.length - 1; !r.to && i >= Math.max(0, v.rows.length - 4); i--) {
    const near = v.rows[i];
    if (near.k !== "refusal" || near.to) continue;
    near.from ||= r.from;
    near.category ||= r.category;
    near.text ||= r.text;
    near.ask ||= r.ask;
    return;
  }
  v.rows.push({ k: "refusal", id: sysId(v, m), ...r });
}

function onAssistant(v: View, m: Msg): void {
  const parent = (m.parent_tool_use_id as string | null | undefined) ?? "";
  const msg: Msg = m.message ?? {};
  // отказ модели без повтора: claude присылает ответ-ошибку — не ответом, а плашкой
  if (msg.stop_reason === "refusal" && (m.isApiErrorMessage || m.error)) {
    if (!parent) addRefusal(v, m, { from: msg.model, category: msg.stop_details?.category || undefined, text: msg.stop_details?.explanation || undefined });
    return;
  }
  if (!parent) {
    // ответ лишь говорит, чья реплика; смену модели объявляет init
    if (typeof msg.model === "string") v.model = msg.model;
    v.hint = "";
  }
  const rows = place(v, parent);
  const id = String(msg.id ?? m.uuid);
  if (rows) addBlocks(v, rows, parent, id, String(m.uuid), blocksOf(msg.content));
  if (typeof m.error === "string" && !parent) banError(v, m, ERRORS[m.error] ?? m.error);
}

function addBlocks(v: View, rows: Row[], parent: string, id: string, uuid: string, blocks: Msg[]): void {
  // кусочки живого текста и размышления этого сообщения сменяет готовый блок
  const known = rows.find((r): r is Extract<Row, { k: "reply" }> => r.k === "reply" && r.id === id);
  if (known) known.parts = known.parts.filter((p) => !("live" in p && p.live));
  for (const b of blocks) {
    if (b.type === "text" && String(b.text ?? "").trim()) {
      const reply = replyIn(rows, id);
      reply.parts.push({ k: "text", pid: `${id}.${reply.parts.length}`, uuid, text: String(b.text) });
    } else if (b.type === "thinking" || b.type === "redacted_thinking") {
      const reply = replyIn(rows, id);
      const last = reply.parts.at(-1);
      if (last?.k === "think") last.text += String(b.thinking ?? "");
      else reply.parts.push({ k: "think", pid: `${id}.${reply.parts.length}`, uuid, text: String(b.thinking ?? "") });
    } else if ((b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") && b.id) addTool(v, rows, parent, id, uuid, b);
  }
}

function addTool(v: View, rows: Row[], parent: string, id: string, uuid: string, b: Msg): void {
  const tool = toolOf(v, String(b.id));
  if (tool.card) return;
  tool.card = true;
  tool.name = String(b.name ?? "");
  tool.input = (b.input as Msg) ?? {};
  replyIn(rows, id).parts.push({ k: "tool", pid: tool.id, uuid, tool: tool.id });
  if (tool.name === "TodoWrite" && !parent) v.todo = tool.id;
  // задача могла начаться раньше вызова
  for (const t of Object.values(v.tasks)) if (t.tool === tool.id) tool.task = t.id;
}

function onStream(v: View, m: Msg): void {
  const e: Msg = m.event ?? {};
  const parent = (m.parent_tool_use_id as string | null | undefined) ?? "";
  if (e.type === "message_start") {
    v.streams[parent] = String(e.message?.id);
    return;
  }
  if (e.type !== "content_block_delta") return;
  const d: Msg = e.delta ?? {};
  const kind = d.type === "text_delta" ? "text" : d.type === "thinking_delta" ? "think" : null;
  const id = v.streams[parent];
  const rows = place(v, parent);
  const piece = String(d.text ?? d.thinking ?? "");
  if (!kind || !id || !rows || !piece) return;
  const reply = replyIn(rows, id);
  const last = reply.parts.at(-1);
  if (last && last.k === kind && last.live) {
    last.text += piece;
    return;
  }
  reply.parts.push({ k: kind, pid: `${id}.${reply.parts.length}`, uuid: "", text: piece, live: true });
  if (!v.open.some((o) => o.id === id && o.parent === parent)) v.open.push({ parent, id });
}

/** Конец хода: то, что пришло кусочками и не сменилось готовым блоком, закончено. */
function closeLive(v: View): void {
  for (const o of v.open) {
    const rows = place(v, o.parent);
    if (!rows) continue;
    for (const r of rows) {
      if (r.k !== "reply" || r.id !== o.id) continue;
      for (const p of r.parts) if ("live" in p) p.live = false;
    }
  }
  v.open = [];
}

/** Отозванный моделью ответ: его частей больше нет. */
function retract(v: View, uuids: string[]): void {
  v.rows = v.rows.filter((r) => {
    if (r.k !== "reply") return true;
    r.parts = r.parts.filter((p) => !uuids.includes(p.uuid));
    return r.parts.length > 0;
  });
}

// ───────────── ввод ─────────────

/** Тег сообщения другой сессии флота во вводе. */
const FLEET = /^<fleet-message from="([^"]+)">\n?([\s\S]*?)\n?<\/fleet-message>$/;
/** Тег вопроса другой сессии; последняя строка — указание модели, человеку она не нужна. */
const FLEET_QUESTION = /^<fleet-question from="([^"]+)"[^>]*>\n?([\s\S]*?)\n?(?:Ответь инструментом fleet\.answer:[^\n]*\n?)?<\/fleet-question>$/;
/** Обёртки claude у сообщений другой сессии и субагента, пришедших посреди хода. */
const WRAP = /^<(cross-session-message|agent-message)\b([^>]*)>\n?([\s\S]*?)\n?<\/\1>\s*$/;
const PEER = /^Another Claude session sent a message(?: while you were working)?:\n([\s\S]*?)(?:\n\nThis came from another Claude session|$)/;
const SUMMARY = /^This session is being continued from a previous conversation/;
const attr = (s: string, k: string) => new RegExp(`${k}="([^"]*)"`).exec(s)?.[1];
const tagOf = (text: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1];

type Peer = { text: string; kind: "session" | "agent"; name?: string; mode?: string };

/** Сообщение не от человека: откуда и что; от человека — null. */
function peerOf(raw: string, origin: Msg | undefined): Peer | null {
  const fl = FLEET.exec(raw) ?? FLEET_QUESTION.exec(raw);
  if (fl) return { text: fl[2], kind: "session", name: fl[1] };
  if (origin?.kind !== "peer" && !WRAP.test(raw) && !PEER.test(raw)) return null;
  const inner = (PEER.exec(raw)?.[1] ?? raw).trim();
  const w = WRAP.exec(inner);
  return {
    text: String(origin?.body || (w ? w[3] : inner)).trim(),
    kind: origin?.senderTaskId || w?.[1] === "agent-message" ? "agent" : "session",
    name: origin?.name || (w && attr(w[2], "from-name")) || undefined,
    mode: origin?.fromMode || (w && attr(w[2], "from-mode")) || undefined,
  };
}

/** Текст сводки сжатия без обёртки claude: служебные вставки, вступление и хвост «продолжай». */
function summaryOf(t: string): string {
  const s = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  const from = s.search(/^Summary:\s*$/m);
  const body = from >= 0 ? s.slice(from).replace(/^Summary:\s*/, "") : s.replace(SUMMARY, "").replace(/^[^\n]*\n?/, "");
  return body.replace(/\n(If you need specific details from before compaction|Continue the conversation from where it left off)[\s\S]*$/, "").trim();
}

function setResult(v: View, b: Msg): void {
  const tool = toolOf(v, String(b.tool_use_id));
  const c: unknown = b.content;
  const blocks = Array.isArray(c) ? (c as Msg[]) : [];
  const text = typeof c === "string" ? c : Array.isArray(c) ? blocks.filter((x) => x.type === "text").map((x) => String(x.text ?? "")).join("\n") : c == null ? "" : JSON.stringify(c);
  tool.result = { text, images: imagesOf(blocks), isError: !!b.is_error };
}

/** Служебное от claude в тексте ввода: разбирает и отвечает, что это было не сообщение. */
function special(v: View, m: Msg, text: string, env: FoldEnv): boolean {
  const id = () => sysId(v, m);
  if (text.startsWith("[Request interrupted")) {
    v.interrupted = true;
    const at = atOf(m);
    v.rows.push({ k: "sys", id: id(), icon: "stop", text: `прервано${at ? ` · ${env.time(at / 1000)}` : ""}`, tone: "wait" });
    return true;
  }
  if (text.startsWith("<task-notification>")) {
    notice(v, m, text);
    return true;
  }
  const cmd = /^<command-name>\/?([^<]+)<\/command-name>/.exec(text) ?? /^<command-message>\/?([^<]+)<\/command-message>/.exec(text);
  if (cmd) {
    addCommand(v, id(), `/${cmd[1]}`, tagOf(text, "command-args")?.trim() ?? "");
    return true;
  }
  const out = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>/.exec(text);
  if (out) {
    addOutput(v, id(), out[1].trim());
    return true;
  }
  return text.startsWith("<local-command") || text.startsWith("Caveat:") || text.startsWith("<system-reminder>");
}

function notice(v: View, m: Msg, text: string): void {
  const status = tagOf(text, "status");
  const summary = tagOf(text, "summary");
  if (status || summary) endTask(v, String(tagOf(text, "task-id")), status ?? "completed", summary, sysId(v, m));
}

function onUser(v: View, m: Msg, env: FoldEnv): void {
  const blocks = blocksOf(m.message?.content);
  for (const b of blocks) if (b.type === "tool_result" && b.tool_use_id) setResult(v, b);
  const raw = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
  if (m.origin?.kind === "task-notification") {
    if (raw.startsWith("<task-notification>")) notice(v, m, raw);
    return;
  }
  const id = userId(v, m);
  // сводка сжатия: на строке границы; в истории границы может не быть — своей строкой
  if (m.isCompactSummary || (!m.parent_tool_use_id && SUMMARY.test(raw))) return addSummary(v, id, summaryOf(raw));
  const peer = peerOf(raw, m.origin);
  // задание субагенту и служебное (в потоке isSynthetic, в файле разговора isMeta)
  if (m.parent_tool_use_id || ((m.isSynthetic || m.isMeta) && !peer)) return;
  const pics = imagesOf(blocks);
  const text = peer ? peer.text : raw;
  if (!text && !blocks.some((b) => b?.type === "image")) return;
  if (!peer && special(v, m, text, env)) return;
  // следующий ход начался — подсказка прошлого не нужна
  v.hint = "";
  if (peer) v.rows.push({ k: "in", id, kind: peer.kind, name: peer.name, mode: peer.mode, text });
  else v.rows.push({ k: "me", id, uuid: id, text, pics });
}

/** Слэш-команда: вывод claude присылает раньше имени (/compact) — имя той же строке; своего пузыря «/команда» не остаётся. */
function addCommand(v: View, id: string, name: string, args: string): void {
  const recent = v.rows.slice(-6);
  const own = recent.find((r) => r.k === "me" && r.text.trim().split(/\s/)[0] === name);
  if (own) v.rows.splice(v.rows.indexOf(own), 1);
  const nameless = recent.findLast((r): r is Extract<Row, { k: "cmd" }> => r.k === "cmd" && !r.name);
  if (nameless) {
    nameless.name = name;
    nameless.args = args;
  } else v.rows.push({ k: "cmd", id, name, args, out: "" });
}

/** Вывод команды — её строке, если она только что была и ещё без вывода; иначе своей строкой. */
function addOutput(v: View, id: string, out: string): void {
  const last = v.rows.slice(-4).findLast((r): r is Extract<Row, { k: "cmd" }> => r.k === "cmd" && !r.out);
  if (last) last.out = out;
  else v.rows.push({ k: "cmd", id, name: "", args: "", out });
}

function addSummary(v: View, id: string, summary: string): void {
  for (let i = v.rows.length - 1; i >= 0; i--) {
    const r = v.rows[i];
    if (r.k === "sum" && r.summary === undefined) {
      r.summary = summary;
      return;
    }
  }
  v.rows.push({ k: "sum", id, summary });
}

function addBoundary(v: View, m: Msg): void {
  v.compacting = false;
  const meta: Msg = (field(m, "compact_metadata") as Msg | undefined) ?? {};
  const pre = field(meta, "pre_tokens") as number | undefined;
  const post = field(meta, "post_tokens") as number | undefined;
  for (let i = v.rows.length - 1; i >= 0; i--) {
    const r = v.rows[i];
    if (r.k === "sum" && !r.bound) {
      Object.assign(r, { pre, post, bound: true });
      return;
    }
  }
  v.rows.push({ k: "sum", id: sysId(v, m), pre, post, bound: true });
}

// ───────────── задачи ─────────────

function taskOf(v: View, m: Msg): Task {
  const id = String(m.task_id);
  const t = (v.tasks[id] ??= { id, desc: "", type: "local_bash", bg: false, ended: false, startedAt: atOf(m) });
  if (m.description) t.desc = String(m.description);
  if (m.task_type) t.type = String(m.task_type);
  return t;
}

const TASK_WORD: Record<string, [string, Tone]> = {
  completed: ["Задача завершена", "ok"],
  failed: ["Задача упала", "bad"],
  stopped: ["Задача остановлена", "wait"],
  killed: ["Задача оборвана", "wait"],
};

/** Строка конца задачи: одна на задачу, каким бы каналом конец ни пришёл. */
export const taskEndText = (t: Task): { text: string; dim?: string; tone: Tone } => {
  const [text, tone] = TASK_WORD[t.status ?? "completed"] ?? TASK_WORD.completed;
  const what = t.desc || t.summary;
  return { text, tone, ...(what ? { dim: ` · ${what}` } : {}) };
};

function startTask(v: View, m: Msg): void {
  const t = taskOf(v, m);
  t.bg = m.is_backgrounded === true || t.bg;
  const toolId = m.tool_use_id as string | undefined;
  if (toolId) t.tool = toolId;
  const tool = toolId ? v.tools[toolId] : undefined;
  if (tool) tool.task = t.id;
  // задача без вызова инструмента видна своей строкой: её карточки нет
  else if (!toolId && !v.rows.some((r) => r.k === "task" && r.task === t.id)) v.rows.push({ k: "task", id: sysId(v, m), task: t.id });
}

function endTask(v: View, id: string, status: string, summary: unknown, rid: string): void {
  const t = (v.tasks[id] ??= { id, desc: "", type: "local_bash", bg: false, ended: false });
  if (t.ended) return;
  t.ended = true;
  t.status = status;
  if (typeof summary === "string") t.summary = summary;
  const hasRow = v.rows.some((r) => r.k === "task" && r.task === id);
  const tool = t.tool ? v.tools[t.tool] : undefined;
  // конец у вызова без фона виден в его карточке
  if (!hasRow && (!tool || t.bg)) v.rows.push({ k: "task", id: rid, task: id });
}

function patchTask(v: View, m: Msg): void {
  const t = taskOf(v, m);
  const patch: Msg = m.patch ?? {};
  if (patch.is_backgrounded != null) t.bg = patch.is_backgrounded === true;
  if (patch.status && patch.status !== "running" && patch.status !== "pending" && !t.ended) {
    t.ended = true;
    t.status = String(patch.status);
  }
}

/** Набор фона от SDK: чего в нём нет, то кончилось. */
function setBackground(v: View, m: Msg): void {
  const list = (m.tasks as Msg[] | undefined) ?? [];
  const ids = new Set(list.map((x) => String(x.task_id)));
  for (const x of list) taskOf(v, x).bg = true;
  for (const t of Object.values(v.tasks)) {
    if (t.bg && !t.ended && !ids.has(t.id)) {
      t.ended = true;
      t.status = "completed";
    }
  }
}

// ───────────── служебное ─────────────

function line(v: View, m: Msg, icon: Icon, text: string, tone: Tone = "", dim?: string): void {
  v.rows.push({ k: "line", id: sysId(v, m), icon, text, tone, ...(dim ? { dim } : {}) });
}

/** Почему основная модель не ответила. */
const FALLBACK: Record<string, string> = { model_not_found: "недоступна", permission_denied: "недоступна организации", overloaded: "перегружена", server_error: "не ответила (сбой сервера)", last_resort: "не ответила (ошибка)", model_blocked: "временно отключена" };

const refusedFields = (m: Msg) => ({ from: field(m, "original_model") as string | undefined, category: (field(m, "api_refusal_category") as string | undefined) || undefined, text: (field(m, "api_refusal_explanation") as string | undefined) || undefined });

/** Строка сведений: важное — плашкой, в фокусе обе прячутся. */
function info(v: View, m: Msg, text: string, warn: boolean): void {
  if (warn) v.rows.push({ k: "ban", id: sysId(v, m), icon: "info", tone: "wait", title: text, quiet: true });
  else line(v, m, "info", text);
}

function onSystem(v: View, m: Msg): void {
  const id = () => sysId(v, m);
  switch (m.subtype as string) {
    case "init":
      if (typeof m.model === "string") {
        const was = v.model;
        v.model = m.model;
        if (was && modelName(was) !== modelName(m.model)) v.rows.push({ k: "sys", id: id(), icon: "model", text: `модель: ${modelName(was)} → ${modelName(m.model)}` });
      }
      return;
    case "status":
      v.compacting = m.status === "compacting";
      if (m.compact_result === "failed") banError(v, m, `Сжать контекст не вышло${m.compact_error ? `: ${String(m.compact_error)}` : ""}`);
      return;
    case "thinking_tokens":
      v.thinking = Number(m.estimated_tokens ?? 0);
      return;
    case "session_state_changed":
      if (m.state === "idle") {
        v.thinking = 0;
        v.compacting = false;
      }
      return;
    case "compact_boundary":
      return addBoundary(v, m);
    case "api_retry": {
      const last = v.rows.at(-1);
      const error = m.error_status ? String(m.error_status) : (m.error as string | undefined);
      const text = `повтор запроса к API · ${m.attempt ?? "?"} из ${m.max_retries ?? "?"}${error ? ` · ${error}` : ""}${m.retry_delay_ms ? ` · через ${Math.round(Number(m.retry_delay_ms) / 1000)} с` : ""}`;
      if (last?.k === "sys" && last.retry) last.text = text;
      else v.rows.push({ k: "sys", id: id(), icon: "retry", text, tone: "wait", retry: true });
      return;
    }
    case "local_command_output":
      return addOutput(v, id(), String(m.content ?? "").trim());
    case "model_fallback": {
      const from = modelName(String(field(m, "original_model") ?? "")) || "Модель";
      v.rows.push({ k: "ban", id: id(), icon: "shuffle", tone: "wait", title: `${from} ${FALLBACK[String(m.trigger ?? "")] ?? "не ответила"} — этот ход отвечает ${modelName(String(field(m, "fallback_model") ?? ""))}` });
      return;
    }
    case "model_refusal_fallback":
      // начатый ответ claude отзывает и переписывает запасной моделью
      retract(v, (field(m, "retracted_message_uuids") as string[] | undefined) ?? []);
      return addRefusal(v, m, { ...refusedFields(m), to: field(m, "fallback_model") as string | undefined, local: m.scope === "local" });
    case "model_refusal_no_fallback": {
      const uuid = field(m, "refused_user_message_uuid") as string | undefined;
      const ask = uuid ? v.rows.find((r): r is Extract<Row, { k: "me" }> => r.k === "me" && r.uuid === uuid)?.text : undefined;
      return addRefusal(v, m, { ...refusedFields(m), ask });
    }
    case "hook_response":
      // удачные хуки не показываются
      if (m.outcome === "error" || (m.exit_code != null && m.exit_code !== 0)) {
        const why = String(m.stderr || m.output || "").trim();
        line(v, m, "anchor", `Хук ${String(m.hook_name ?? "")} не сработал${m.exit_code != null ? ` (код ${String(m.exit_code)})` : ""}`, "wait", why ? `: ${why.slice(0, 300)}` : undefined);
      }
      return;
    case "memory_recall": {
      const list = (m.memories as Msg[] | undefined) ?? [];
      if (list.length) line(v, m, "memory", `Из памяти: ${list.map((x) => baseName(String(x.path))).join(", ")}`);
      return;
    }
    case "informational":
      if (m.content) info(v, m, String(m.content), m.level === "warning");
      return;
    case "notification":
      if (m.text) info(v, m, String(m.text), m.priority === "high" || m.priority === "immediate");
      return;
    case "permission_denied":
      line(v, m, "ban", `Отклонено правилами: ${String(m.tool_name ?? "")}${typeof m.message === "string" && m.message ? ` — ${m.message}` : ""}`);
      return;
    case "files_persisted": {
      const ok = ((m.files as Msg[] | undefined) ?? []).map((x) => String(x.filename));
      const bad = ((m.failed as Msg[] | undefined) ?? []).map((x) => `${String(x.filename)}: ${String(x.error)}`);
      const parts = [ok.length ? `Файлы сохранены: ${ok.join(", ")}` : "", bad.length ? `Не сохранились: ${bad.join(", ")}` : ""].filter(Boolean);
      line(v, m, "file", parts.join(" · "), bad.length ? "bad" : "");
      return;
    }
    case "mirror_error":
      if (m.error) banError(v, m, String(m.error));
      return;
    case "plugin_install":
      if (m.status === "failed") banError(v, m, `Плагин не установился${m.name ? ` (${String(m.name)})` : ""}${m.error ? `: ${String(m.error)}` : ""}`);
      return;
    case "task_started":
      return startTask(v, m);
    case "task_progress": {
      const t = taskOf(v, m);
      if (typeof m.summary === "string") t.summary = m.summary;
      if (typeof m.last_tool_name === "string") t.lastTool = m.last_tool_name;
      const uses = (m.usage as Msg | undefined)?.tool_uses;
      if (typeof uses === "number") t.uses = uses;
      return;
    }
    case "task_updated":
      return patchTask(v, m);
    case "task_notification": {
      const t = taskOf(v, m);
      const status = m.status === "completed" ? "completed" : m.status === "failed" ? "failed" : "stopped";
      return endTask(v, t.id, status, m.summary, id());
    }
    case "background_tasks_changed":
      return setBackground(v, m);
  }
}

/** Почему оборвался ход: подтипы result у SDK; незнакомый — как есть. */
const EXIT: Record<string, string> = { error_during_execution: "сбой при выполнении", error_max_turns: "предел шагов", error_max_budget_usd: "предел бюджета", error_max_structured_output_retries: "предел повторов ответа" };

function onResult(v: View, m: Msg, duration: (ms: number) => string): void {
  closeLive(v);
  v.thinking = 0;
  const was = v.interrupted;
  v.interrupted = false;
  if (m.is_error && was) return;
  const total = m.total_cost_usd;
  let cost: number | undefined;
  if (typeof total === "number") {
    cost = total >= v.cost ? total - v.cost : total;
    v.cost = total;
  }
  if (m.subtype !== "success" || m.is_error) {
    const sub = m.subtype as string | undefined;
    const errors = (m.errors as string[] | undefined)?.join("; ");
    const err = (m.result as string | undefined) || errors || undefined;
    v.rows.push({ k: "end", id: sysId(v, m), text: `ход оборвался: ${EXIT[sub ?? ""] ?? sub ?? "ошибка"}`, ...(err ? { err } : {}) });
    return;
  }
  const usage: Msg | undefined = m.usage;
  const context = usage ? Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) : 0;
  const bits = ["ход закончен", m.duration_ms ? duration(Number(m.duration_ms)) : "", typeof m.num_turns === "number" ? steps(m.num_turns) : "", cost !== undefined ? costText(cost) : "", context ? `${kTokens(context)} в контексте` : ""];
  v.rows.push({ k: "res", id: sysId(v, m), bits: bits.filter(Boolean) });
}

function onRate(v: View, m: Msg, time: (t: number) => string): void {
  const r: Msg = m.rate_limit_info ?? {};
  if (!r.status || r.status === "allowed") return;
  const window = r.rateLimitType ? (LIMIT_NAMES[String(r.rateLimitType)] ?? String(r.rateLimitType)) : "";
  const reset = r.resetsAt ? `сброс в ${time(Number(r.resetsAt))}` : "";
  const body = [window, reset].filter(Boolean).join(", ");
  v.rows.push({ k: "ban", id: sysId(v, m), icon: "gauge", tone: "wait", title: r.status === "rejected" ? "Лимит подписки исчерпан" : "Лимит подписки скоро кончится", ...(body ? { body } : {}) });
}

/** Всё, что свёртка берёт снаружи: время и длительность — словами страницы. */
export type FoldEnv = { duration(ms: number): string; time(t: number): string };

/** Один шаг свёртки над черновиком. */
function step(v: View, m: Msg, env: FoldEnv): void {
  if (typeof m.uuid === "string" && m.type !== "stream_event") {
    if (v.seen[m.uuid]) return;
    v.seen[m.uuid] = true;
  }
  switch (m.type as string) {
    case "assistant":
      return onAssistant(v, m);
    case "user":
      return onUser(v, m, env);
    case "stream_event":
      return onStream(v, m);
    case "system":
      return onSystem(v, m);
    case "result":
      return onResult(v, m, env.duration);
    case "rate_limit_event":
      return onRate(v, m, env.time);
    case "tool_progress": {
      const tool = v.tools[String(m.tool_use_id)];
      if (tool) tool.secs = Number(m.elapsed_time_seconds);
      return;
    }
    case "tool_use_summary": {
      const ids = (m.preceding_tool_use_ids as string[] | undefined) ?? [];
      const tool = v.tools[String(ids.at(-1))];
      if (tool && m.summary) tool.note = String(m.summary);
      return;
    }
    case "prompt_suggestion":
      v.hint = String(m.suggestion ?? "").trim();
      return;
    case "auth_status":
      if (m.error) banError(v, m, String(m.error));
      return;
    case "conversation_reset":
      v.rows.push({ k: "sys", id: sysId(v, m), icon: "reset", text: "разговор начат заново" });
      return;
    // свои записи страницы: сообщение сессии владельцу и смена аккаунта
    case "_inbox":
      v.rows.push({ k: "in", id: sysId(v, m), kind: "owner", name: String(m.from), text: String(m.text ?? ""), at: m.at as number, push: m.push === true });
      return;
    case "_swap":
      v.rows.push({ k: "sys", id: sysId(v, m), icon: "swap", text: String(m.text), tone: "swap" });
      return;
  }
}

/** Новое состояние после одного сообщения. */
export function fold(state: View, m: Msg, env: FoldEnv): View {
  return produce(state, (d) => step(d as View, m, env));
}

/** Разговор целиком: тот же шаг. */
export function foldAll(log: Msg[], env: FoldEnv): View {
  return produce(emptyView(), (d) => {
    for (const m of log) step(d as View, m, env);
  });
}

/** Отказ человека словами claude — не «Permission denied» в выводе команды. */
export const isRefused = (text: string) => /^(The user doesn't want to proceed|User rejected|Permission to use .+ has been denied)/.test(text);
/** Причина человека без обёртки claude; нет причины — пусто: отказ уже назван в шапке карточки. */
export const refusalReason = (text: string) => /Reason: ([\s\S]*)$/.exec(text)?.[1].trim() ?? "";

/** Состояние инструмента: одно правило на карточку, сводку и галерею. */
export type ToolState = "running" | "wait" | "ok" | "error" | "denied" | "bg" | "stopped";

export function toolState(tool: Tool, task: Task | undefined, waiting: boolean): ToolState {
  if (waiting && !tool.result) return "wait";
  if (task?.ended && (task.status === "stopped" || task.status === "killed")) return "stopped";
  if (task?.bg && !task.ended) return "bg";
  if (!tool.result) return "running";
  if (!tool.result.isError) return "ok";
  return isRefused(tool.result.text) ? "denied" : "error";
}
