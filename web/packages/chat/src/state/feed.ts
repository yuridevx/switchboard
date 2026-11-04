// Свёртка ленты: сообщения SDK → записи, инструменты и задачи. Одна для живого потока и истории; повтор по uuid отбрасывается.
// Снаружи чистая: applyEvents(feed, сообщения) → новый снимок, неизменённые записи сохраняют ссылку (рисуется только новое).
import { produce, type Draft } from "immer";
import { contentOf, imageUrl, isSummary, peerOf, resultOf, specialOf, summaryOf, textOf } from "./parse.ts";
import { isEnded, type AsstItem, type Feed, type Item, type Part, type Sys, type SysItem, type Task, type TaskStatus, type Tool, type UserItem } from "./types.ts";
import type { WireContent, WireMessage, WireTask, WireUsage } from "./wire.ts";

type D = Draft<Feed>;

export const emptyFeed = (): Feed => ({ items: [], tools: {}, tasks: {}, seen: {}, byMsg: {}, orphans: {}, live: null, ended: {}, cut: false, cost: 0, suggestion: "", compacting: false, n: 0 });

/** Ошибки ответа claude — по-русски. */
const ERR: Record<string, string> = {
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

const atOf = (m: WireMessage) => (m.timestamp ? Date.parse(m.timestamp) : Date.now());
const asStatus = (s?: string): TaskStatus => (s === "failed" || s === "stopped" || s === "killed" ? s : "completed");
const isLive = (p: Part) => (p.kind === "text" || p.kind === "think") && !!p.live;
const findUser = (d: D, id: string) => d.items.findLast((i): i is Draft<UserItem> => i.kind === "user" && i.id === id);
const findAsst = (d: D, id: string) => d.items.findLast((i): i is Draft<AsstItem> => i.kind === "assistant" && i.id === id);

function addSys(d: D, sys: Sys, at: number | undefined, uuid?: string) {
  // повтор запроса подряд — одна строка с последней попыткой
  const last = d.items.at(-1);
  if (sys.type === "retry" && last?.kind === "sys" && last.sys.type === "retry") {
    last.sys = sys;
    return;
  }
  d.items.push({ kind: "sys", id: uuid ? `s:${uuid}` : `s${++d.n}`, sys, at });
}

/** Отказ модели: ответ-ошибка и событие claude об одном отказе — одной плашкой; пришедшее позже дополняет. */
function refusal(d: D, r: Omit<Extract<Sys, { type: "refusal" }>, "type">, at: number, uuid?: string) {
  for (let i = d.items.length - 1; !r.to && i >= Math.max(0, d.items.length - 4); i--) {
    const near = d.items[i];
    if (near.kind !== "sys" || near.sys.type !== "refusal" || near.sys.to) continue;
    const s = near.sys;
    s.from ||= r.from;
    s.category ||= r.category;
    s.text ||= r.text;
    s.ask ||= r.ask;
    return;
  }
  addSys(d, { type: "refusal", ...r }, at, uuid);
}

function toolResults(d: D, c?: WireContent) {
  if (!Array.isArray(c)) return;
  for (const b of c) {
    if (b?.type !== "tool_result" || !b.tool_use_id) continue;
    const r = { ...resultOf(b.content), isError: !!b.is_error };
    const t = d.tools[b.tool_use_id];
    if (t) t.result = r;
    else d.orphans[b.tool_use_id] = r;
  }
}

/** Слэш-команда: вывод claude присылает раньше имени (/compact) — имя той же строке; своего пузыря «/команда» не остаётся. */
function command(d: D, name: string, args: string | undefined, at: number, uuid?: string) {
  const recent = d.items.slice(-6);
  const own = recent.find((i) => i.kind === "user" && i.text.trim().split(/\s/)[0] === name);
  if (own) d.items.splice(d.items.indexOf(own), 1);
  const nameless = recent.findLast((i): i is Draft<SysItem> => i.kind === "sys" && i.sys.type === "command" && !i.sys.name);
  if (nameless?.sys.type === "command") {
    nameless.sys.name = name;
    nameless.sys.args = args;
  } else addSys(d, { type: "command", name, args }, at, uuid);
}

/** Вывод команды — её строке, если она только что была и ещё без вывода; иначе своей строкой. */
function commandOutput(d: D, text: string, at: number, uuid?: string) {
  const last = d.items.slice(-4).findLast((i): i is Draft<SysItem> => i.kind === "sys" && i.sys.type === "command" && !i.sys.output);
  if (last?.sys.type === "command") last.sys.output = text;
  else addSys(d, { type: "command", name: "", output: text }, at, uuid);
}

function taskNotice(d: D, id: string | undefined, status: string | undefined, summary: string | undefined, at: number, uuid?: string) {
  if (id && d.ended[id]) return;
  if (id) d.ended[id] = true;
  if (status || summary) addSys(d, { type: "task", status: asStatus(status), description: summary ?? "" }, at, uuid);
}

function user(d: D, m: WireMessage, at: number) {
  const c = contentOf(m);
  toolResults(d, c);
  const raw = textOf(c).trim();
  if (m.origin?.kind === "task-notification") {
    const s = specialOf(raw);
    if (s?.kind === "task") taskNotice(d, s.id, s.status, s.summary, at, m.uuid);
    return;
  }
  // сводка сжатия: на строке границы, если та только что была; в истории границы нет — своей строкой
  if (isSummary(m, raw)) {
    const prev = d.items.at(-1);
    if (prev?.kind === "sys" && prev.sys.type === "compact") {
      prev.sys.summary = summaryOf(raw);
      // в истории та же сводка бывает своей строкой: склейка находит её по этой записи
      if (m.uuid) d.byMsg[`s:${m.uuid}`] = prev.id;
    } else addSys(d, { type: "compact", summary: summaryOf(raw) }, at, m.uuid);
    return;
  }
  const peer = peerOf(raw, m.origin);
  // задание субагенту и служебное (в потоке isSynthetic, в файле разговора isMeta)
  if (m.parent_tool_use_id || ((m.isSynthetic || m.isMeta) && !peer)) return;
  const images = Array.isArray(c) ? c.filter((b) => b?.type === "image") : [];
  const text = peer ? peer.text : raw;
  if (!text && !images.length) return;
  const sp = peer ? null : specialOf(text);
  if (sp) {
    if (sp.kind === "interrupted") {
      d.cut = true;
      addSys(d, { type: "interrupted" }, at, m.uuid);
    } else if (sp.kind === "command") command(d, sp.name, sp.args, at, m.uuid);
    else if (sp.kind === "output") commandOutput(d, sp.text, at, m.uuid);
    else if (sp.kind === "task") taskNotice(d, sp.id, sp.status, sp.summary, at, m.uuid);
    return;
  }
  // следующий ход начался — подсказка прошлого не нужна
  d.suggestion = "";
  d.items.push({ kind: "user", id: m.uuid ?? `u${++d.n}`, text, images: images.map(imageUrl).filter(Boolean), files: [], at: m.timestamp ? at : undefined, from: peer?.from });
}

/** Части ответа: в запись ленты или, у субагента, в карточку его инструмента. */
function target(d: D, msg: string, parent: string | null, at: number, model?: string): Part[] {
  const t = parent ? d.tools[parent] : undefined;
  if (t) return t.parts;
  const id = d.byMsg[msg];
  const known = id ? findAsst(d, id) : undefined;
  if (known) return known.parts;
  d.byMsg[msg] = `a${msg}`;
  d.items.push({ kind: "assistant", id: `a${msg}`, parts: [], model, at, uuids: [] });
  return (d.items.at(-1) as Draft<AsstItem>).parts;
}

function assistant(d: D, m: WireMessage, at: number) {
  const msg = typeof m.message === "object" && m.message ? m.message : {};
  const key = msg.id || m.uuid;
  if (!key) return;
  const parent = m.parent_tool_use_id || null;
  const parts = target(d, key, parent, at, msg.model);
  if (!parent) {
    if (msg.model) d.model = msg.model;
    d.suggestion = "";
    if (m.uuid) findAsst(d, d.byMsg[key])?.uuids.push(m.uuid);
  }
  // кусочки живого текста и размышления этого сообщения сменяет готовый блок
  for (let i = parts.length - 1; i >= 0; i--) if (isLive(parts[i])) parts.splice(i, 1);
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (b.type === "text" && b.text?.trim()) parts.push({ kind: "text", text: b.text });
    else if (b.type === "thinking" || b.type === "redacted_thinking") {
      const last = parts.at(-1);
      if (last?.kind === "think") last.text += b.thinking ?? "";
      else parts.push({ kind: "think", text: b.thinking ?? "" });
    } else if ((b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") && b.id) {
      d.tools[b.id] ??= { id: b.id, name: b.name ?? "", input: b.input ?? {}, parts: [], parent, result: d.orphans[b.id] };
      parts.push({ kind: "tool", id: b.id });
    }
  }
}

/** Текст ответа и размышление кусочками: растут, пока не придёт готовый блок. */
function stream(d: D, m: WireMessage) {
  const e = m.event ?? {};
  if (e.type === "message_start") {
    d.live = e.message?.id ? { msg: e.message.id, parent: m.parent_tool_use_id || null } : null;
    return;
  }
  if (e.type !== "content_block_delta" || !d.live) return;
  const kind = e.delta?.type === "text_delta" ? "text" : e.delta?.type === "thinking_delta" ? "think" : null;
  const piece = (kind === "text" ? e.delta?.text : kind === "think" ? e.delta?.thinking : "") ?? "";
  if (!kind || !piece) return;
  const parts = target(d, d.live.msg, d.live.parent, Date.now());
  const last = parts.at(-1);
  if (last && last.kind === kind && last.live) last.text += piece;
  else parts.push({ kind, text: piece, live: true });
}

/** Ход кончен: кусочки, не дождавшиеся готового блока, больше не пишутся. */
function endLive(parts: Draft<Part>[]) {
  for (const p of parts) if ((p.kind === "text" || p.kind === "think") && p.live) p.live = false;
}

function result(d: D, m: WireMessage, at: number) {
  d.live = null;
  for (const it of d.items) if (it.kind === "assistant") endLive(it.parts);
  for (const t of Object.values(d.tools)) endLive(t.parts);
  d.thinking = undefined;
  const interrupted = d.cut;
  d.cut = false;
  if (m.is_error && interrupted) return;
  const total = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
  const cost = total !== undefined && total >= d.cost ? total - d.cost : total;
  if (total !== undefined) d.cost = total;
  const u = m.usage;
  const ok = m.subtype === "success" && !m.is_error;
  addSys(
    d,
    {
      type: "result",
      ok,
      subtype: m.subtype,
      cost,
      ms: m.duration_ms,
      turns: m.num_turns,
      tokens: u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined,
      error: ok ? undefined : m.result || m.errors?.join("; ") || undefined,
    },
    at,
    m.uuid,
  );
}

function taskOf(d: D, m: WireTask & { timestamp?: string }): Draft<Task> {
  const id = String(m.task_id);
  const t = (d.tasks[id] ??= { id, type: m.task_type ?? "local_bash", description: m.description ?? "", status: "running", background: false, startedAt: m.timestamp ? Date.parse(m.timestamp) : Date.now() });
  if (m.tool_use_id) t.toolUseId = m.tool_use_id;
  if (m.description) t.description = m.description;
  if (m.task_type) t.type = m.task_type;
  if (m.subagent_type) t.subagent = m.subagent_type;
  return t;
}

function usage(t: Draft<Task>, u?: WireUsage) {
  if (!u) return;
  t.tokens = u.total_tokens;
  t.toolUses = u.tool_uses;
}

function taskEvent(d: D, m: WireMessage, at: number) {
  switch (m.subtype) {
    case "task_started": {
      const t = taskOf(d, m);
      t.status = "running";
      if (m.is_backgrounded) t.background = true;
      // задача без вызова инструмента видна своей строкой: её карточки нет
      if (!m.tool_use_id) {
        addSys(d, { type: "task", id: t.id, status: "running", description: t.description, kind: t.type }, at, m.uuid);
        d.ended[t.id] = true;
      }
      break;
    }
    case "task_progress": {
      const t = taskOf(d, m);
      if (m.summary) t.summary = m.summary;
      if (m.last_tool_name) t.lastTool = m.last_tool_name;
      usage(t, m.usage);
      break;
    }
    case "task_updated": {
      const t = taskOf(d, m);
      const p = m.patch ?? {};
      if (p.status) t.status = p.status as TaskStatus;
      if (p.is_backgrounded != null) t.background = p.is_backgrounded;
      if (p.end_time) t.endedAt = p.end_time;
      break;
    }
    case "task_notification": {
      const t = taskOf(d, m);
      t.status = m.status === "completed" ? "completed" : m.status === "failed" ? "failed" : "stopped";
      t.endedAt ??= Date.now();
      if (m.summary) t.summary = m.summary;
      usage(t, m.usage);
      // в ленту — конец фоновой задачи; у задач переднего плана итог виден на карточке
      if (t.background && !d.ended[t.id]) {
        d.ended[t.id] = true;
        addSys(d, { type: "task", status: t.status, description: t.description, kind: t.type }, at, m.uuid);
      }
      break;
    }
    case "background_tasks_changed": {
      const live = new Set<string>();
      for (const x of m.tasks ?? []) {
        const t = taskOf(d, x);
        t.background = true;
        live.add(t.id);
        if (!isEnded(t.status)) t.status = "running";
      }
      // ушедшие из набора без своего конца (пропущенный кадр) — уже не идут
      for (const t of Object.values(d.tasks)) {
        if (t.background && t.status === "running" && !live.has(t.id)) {
          t.status = "completed";
          t.endedAt ??= Date.now();
        }
      }
      break;
    }
  }
}

function system(d: D, m: WireMessage, at: number) {
  const refused = () => ({
    from: m.original_model || m.originalModel,
    category: (m.api_refusal_category ?? m.apiRefusalCategory) || undefined,
    text: (m.api_refusal_explanation ?? m.apiRefusalExplanation) || undefined,
  });
  if ((m.subtype === "init" || m.subtype === "status") && m.permissionMode) d.mode = m.permissionMode;
  switch (m.subtype) {
    case "init":
      if (m.model && d.model && m.model !== d.model && !m.model.startsWith(d.model)) addSys(d, { type: "model", from: d.model, to: m.model }, at, m.uuid);
      if (m.model) d.model = m.model;
      break;
    case "status":
      d.compacting = m.status === "compacting";
      if (m.compact_result === "failed") addSys(d, { type: "error", text: `Сжать контекст не вышло${m.compact_error ? `: ${m.compact_error}` : ""}` }, at, m.uuid);
      break;
    case "session_state_changed":
      if (m.state === "idle") {
        d.compacting = false;
        d.thinking = undefined;
      }
      break;
    case "thinking_tokens":
      d.thinking = m.estimated_tokens;
      break;
    case "compact_boundary": {
      const c = m.compact_metadata ?? m.compactMetadata ?? {};
      d.compacting = false;
      addSys(d, { type: "compact", pre: c.pre_tokens ?? c.preTokens, post: c.post_tokens ?? c.postTokens, auto: c.trigger === "auto" }, at, m.uuid);
      break;
    }
    case "api_retry":
      addSys(d, { type: "retry", attempt: m.attempt, max: m.max_retries, error: m.error_status ? String(m.error_status) : m.error, delayMs: m.retry_delay_ms }, at, m.uuid);
      break;
    case "local_command_output":
      commandOutput(d, String(m.content ?? "").trim(), at, m.uuid);
      break;
    case "task_started":
    case "task_progress":
    case "task_updated":
    case "task_notification":
    case "background_tasks_changed":
      taskEvent(d, m, at);
      break;
    case "informational":
      if (m.content) addSys(d, { type: "info", text: m.content, warn: m.level === "warning" }, at, m.uuid);
      break;
    case "notification":
      if (m.text) addSys(d, { type: "info", text: m.text, warn: m.priority === "high" || m.priority === "immediate" }, at, m.uuid);
      break;
    case "permission_denied":
      addSys(d, { type: "denied", tool: m.tool_name ?? "", message: typeof m.message === "string" ? m.message : undefined }, at, m.uuid);
      break;
    case "model_refusal_fallback": {
      // начатый ответ claude отзывает и переписывает запасной моделью
      const gone = new Set(m.retracted_message_uuids ?? m.retractedMessageUuids ?? []);
      d.items = d.items.filter((i) => i.kind !== "assistant" || !i.uuids.some((u) => gone.has(u)));
      refusal(d, { ...refused(), to: m.fallback_model || m.fallbackModel, local: m.scope === "local" }, at, m.uuid);
      break;
    }
    case "model_refusal_no_fallback": {
      const uid = m.refused_user_message_uuid ?? m.refusedUserMessageUuid;
      refusal(d, { ...refused(), ask: uid ? findUser(d, uid)?.text : undefined }, at, m.uuid);
      break;
    }
    case "model_fallback":
      addSys(d, { type: "fallback", from: m.original_model || m.originalModel, to: m.fallback_model || m.fallbackModel, trigger: m.trigger }, at, m.uuid);
      break;
    case "hook_response":
      // удачные хуки не показываются
      if (m.outcome === "error" || (m.exit_code != null && m.exit_code !== 0)) addSys(d, { type: "hook", event: m.hook_event ?? "", name: m.hook_name ?? "", code: m.exit_code, text: String(m.stderr || m.output || "").trim() }, at, m.uuid);
      break;
    case "memory_recall":
      if (m.memories?.length) addSys(d, { type: "memory", paths: m.memories.map((x) => x.path) }, at, m.uuid);
      break;
    case "plugin_install":
      if (m.status === "failed") addSys(d, { type: "error", text: `Плагин не установился${m.name ? ` (${m.name})` : ""}${m.error ? `: ${m.error}` : ""}` }, at, m.uuid);
      break;
    case "files_persisted":
      addSys(d, { type: "files", saved: (m.files ?? []).map((f) => f.filename), failed: (m.failed ?? []).map((f) => `${f.filename}: ${f.error}`) }, at, m.uuid);
      break;
    case "mirror_error":
      if (m.error) addSys(d, { type: "error", text: m.error }, at, m.uuid);
      break;
  }
}

function apply(d: D, m: WireMessage) {
  if (!m || typeof m !== "object") return;
  if (m.uuid && m.type !== "stream_event") {
    if (d.seen[m.uuid]) {
      // эхо своего сообщения — ✓✓
      const mine = findUser(d, m.uuid);
      if (mine?.state) mine.state = "echo";
      return;
    }
    d.seen[m.uuid] = true;
  }
  const at = atOf(m);
  switch (m.type) {
    case "user":
      user(d, m, at);
      break;
    case "assistant": {
      const msg = typeof m.message === "object" ? m.message : undefined;
      // отказ модели без повтора: claude присылает ответ-ошибку — не ответом, а плашкой
      if (msg?.stop_reason === "refusal" && (m.isApiErrorMessage || m.error)) {
        if (!m.parent_tool_use_id) refusal(d, { from: msg.model, category: msg.stop_details?.category || undefined, text: msg.stop_details?.explanation || undefined }, at, m.uuid);
        break;
      }
      assistant(d, m, at);
      if (m.error && !m.parent_tool_use_id) addSys(d, { type: "error", text: ERR[m.error] ?? m.error }, at, m.uuid);
      break;
    }
    case "stream_event":
      stream(d, m);
      break;
    case "system":
      system(d, m, at);
      break;
    case "result":
      result(d, m, at);
      break;
    case "rate_limit_event": {
      const i = m.rate_limit_info ?? {};
      if (i.status && i.status !== "allowed") addSys(d, { type: "limits", status: i.status, window: i.rateLimitType, resets: i.resetsAt }, at, m.uuid);
      break;
    }
    case "tool_progress": {
      const t = m.tool_use_id ? d.tools[m.tool_use_id] : undefined;
      if (t) t.secs = m.elapsed_time_seconds;
      break;
    }
    case "tool_use_summary": {
      const id = m.preceding_tool_use_ids?.at(-1);
      if (id && d.tools[id] && m.summary) d.tools[id].summary = m.summary;
      break;
    }
    case "prompt_suggestion":
      d.suggestion = String(m.suggestion ?? "").trim();
      break;
    case "conversation_reset":
      addSys(d, { type: "reset" }, at, m.uuid);
      break;
    case "auth_status":
      if (m.error) addSys(d, { type: "error", text: m.error }, at, m.uuid);
      break;
  }
}

/** Сообщения SDK → новый снимок. Пачка — одна правка. */
export const applyEvents = (feed: Feed, msgs: WireMessage[]): Feed =>
  produce(feed, (d) => {
    for (const m of msgs) apply(d, m);
  });

/** Одна запись и в ленте, и в истории: у ленты бывает больше (живые кусочки, вложения своего пузыря, строка, дополненная позже). */
function mergeItem(cur: Item, h: Item): Item {
  if (cur.kind === "user" && h.kind === "user" && cur.state) return { ...h, state: "echo", queued: cur.queued, images: cur.images, files: cur.files, at: cur.at };
  if (cur.kind === "assistant" && h.kind === "assistant") return h.uuids.every((u) => cur.uuids.includes(u)) ? cur : h;
  if (cur.kind === "sys" && h.kind === "sys") return Object.keys(h.sys).some((k) => !(k in cur.sys)) ? { ...cur, sys: { ...h.sys, ...cur.sys } as Sys } : cur;
  return cur;
}

/** Карточка из истории и из кадров: шаги субагента и сводку история не несёт, итог мог прийти только кадром. */
function mergeTool(cur: Tool, h: Tool): Tool {
  return { ...h, ...cur, parts: cur.parts.length ? cur.parts : h.parts, result: cur.result ?? h.result };
}

/**
 * Заново из истории — в порядке разговора: запись истории встаёт на своё место в ленте; чего в ней нет
 * (ранние страницы, живые пачки, переписка, свои пузыри, строки итогов) — остаётся там, где стояло. Свой пузырь, найденный в истории, — ✓✓.
 */
export function withHistory(cur: Feed, msgs: WireMessage[]): Feed {
  const h = applyEvents({ ...emptyFeed(), n: cur.n, ended: cur.ended }, msgs);
  const place = new Map(cur.items.map((it, i) => [it.id, i]));
  const items: Item[] = [];
  let i = 0;
  for (const it of h.items) {
    const at = place.get(cur.byMsg[it.id] ?? it.id);
    if (at === undefined) {
      items.push(it);
      continue;
    }
    if (at < i) continue;
    while (i < at) items.push(cur.items[i++]);
    items.push(mergeItem(cur.items[i++], it));
  }
  items.push(...cur.items.slice(i));
  const tools = { ...h.tools, ...cur.tools };
  for (const id of Object.keys(h.tools)) if (cur.tools[id]) tools[id] = mergeTool(cur.tools[id], h.tools[id]);
  const tasks = { ...h.tasks, ...cur.tasks };
  // конец, который лента пропустила, есть только в истории
  for (const id of Object.keys(h.tasks)) if (cur.tasks[id] && isEnded(h.tasks[id].status) && !isEnded(cur.tasks[id].status)) tasks[id] = h.tasks[id];
  return {
    ...h,
    items,
    tools,
    tasks,
    seen: { ...cur.seen, ...h.seen },
    byMsg: { ...cur.byMsg, ...h.byMsg },
    orphans: { ...cur.orphans, ...h.orphans },
    live: cur.live,
    cut: cur.cut,
    cost: Math.max(cur.cost, h.cost),
    suggestion: cur.suggestion,
    compacting: cur.compacting,
    thinking: cur.thinking,
    model: cur.model ?? h.model,
    mode: cur.mode ?? h.mode,
  };
}

/** Более ранняя страница истории: записи — перед текущими; итоги, ждавшие своего вызова, — в карточки; сообщение, разрезанное границей страницы, — одна запись. */
export function withOlder(cur: Feed, msgs: WireMessage[]): Feed {
  const h = applyEvents({ ...emptyFeed(), n: cur.n }, msgs.filter((m) => !m.uuid || !cur.seen[m.uuid]));
  const older = new Map(h.items.map((it) => [it.id, it]));
  const rest = cur.items.map((it) => {
    const early = older.get(it.id);
    return it.kind === "assistant" && early?.kind === "assistant" ? { ...it, parts: [...early.parts, ...it.parts], uuids: [...early.uuids, ...it.uuids], at: early.at } : it;
  });
  const have = new Set(cur.items.map((i) => i.id));
  const tools = { ...h.tools, ...cur.tools };
  const orphans = { ...h.orphans, ...cur.orphans };
  for (const [id, result] of Object.entries(orphans)) {
    if (!tools[id]) continue;
    tools[id] = { ...tools[id], result };
    delete orphans[id];
  }
  return { ...cur, items: [...h.items.filter((i) => !have.has(i.id)), ...rest], tools, orphans, seen: { ...h.seen, ...cur.seen }, byMsg: { ...h.byMsg, ...cur.byMsg }, n: h.n };
}

/** Своё сообщение — сразу в ленту, ждёт reply. */
export const addMine = (feed: Feed, it: Omit<UserItem, "kind" | "state">): Feed =>
  produce(feed, (d) => {
    d.seen[it.id] = true;
    d.suggestion = "";
    d.items.push({ kind: "user", ...it, state: "sending" });
  });
