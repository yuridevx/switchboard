// Свёртка разговора: сообщения SDK по порядку → строки ленты, карточки инструментов, задачи и состояние хода. Чистая функция: живое и история идут одним шагом.
import { at, duration, LIMIT_NAMES } from "@switchboard/web-ui";
import { apiError, area, endWhy, fallbackWhy, kilo, modelName, money, sameModel, steps, taskEnd } from "./words.ts";

export type Msg = Record<string, any>;
export type Part = { k: "text"; text: string } | { k: "think"; text: string; redacted?: boolean } | { k: "tool"; id: string } | { k: "doc"; text: string };
export type Row =
  | { k: "me"; key: string; uuid?: string; text: string; pics: string[] }
  | { k: "in"; key: string; from: "session" | "agent" | "owner"; name: string; mode?: string; text: string; at?: number; push?: boolean }
  | { k: "reply"; key: string; id: string; parts: Part[]; liveText?: string; liveThink?: string; done: boolean }
  | { k: "cmd"; key: string; name: string; out?: string }
  | { k: "sys"; key: string; icon: string; text: string; tone?: "wait" | "swap"; retry?: boolean }
  | { k: "line"; key: string; icon?: string; text: string; dim?: string; tone?: string; out?: boolean; end?: string }
  | { k: "task"; key: string; id: string }
  | { k: "ban"; key: string; tone: "bad" | "wait"; icon: string; title: string; body?: string; edit?: string; refusal?: boolean }
  | { k: "res"; key: string; err?: string; why?: string; parts: string[] }
  | { k: "sum"; key: string; head: string; text: string; bound: boolean };
type Draft<T = Row> = T extends Row ? Omit<T, "key"> & { key?: string } : never;
export type Tool = { id: string; name: string; input: Msg; result?: { content: unknown; error: boolean }; note?: string; elapsed?: number; task?: string; bg?: boolean; sub: Msg[] };
export type Task = { id: string; tool?: string; description?: string; type?: string; summary?: string; last?: string; uses?: number; status: string; bg: boolean; since: number };
export type View = {
  rows: Row[];
  tools: Record<string, Tool>;
  tasks: Record<string, Task>;
  todos?: Array<{ content?: string; activeForm?: string; status?: string }>;
  hint?: string;
  compacting: boolean;
  thinking?: number;
  running?: boolean;
  model?: string;
};

const REFUSED = /^(The user doesn't want to proceed with this tool use\.|User rejected)/;
/** Отказ человека в итоге инструмента и его причина. */
export const deniedWhy = (content: unknown): string | null => {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b?.text ?? "").join("") : "";
  if (!REFUSED.test(text)) return null;
  return /Reason: ([\s\S]*)$/.exec(text)?.[1] ?? "";
};

const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1];
const strip = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");
const picsOf = (content: unknown): string[] =>
  Array.isArray(content) ? content.filter((b) => b?.type === "image" && b.source?.type === "base64" && b.source.data && !String(b.source.data).includes("…")).map((b) => `data:${b.source.media_type};base64,${b.source.data}`) : [];

/** Сводка сжатия без обёртки SDK. */
function summaryText(text: string): string {
  let s = strip(text);
  const at = s.indexOf("Summary:");
  s = at >= 0 ? s.slice(at + "Summary:".length) : s.replace(/^This session is being continued[^\n]*\n?/, "");
  return s.split(/\n?If you need specific details from before compaction/)[0].trim();
}

/** Чужое сообщение во вводе: другая сессия, субагент, вопрос дочери. */
function peerOf(text: string, origin: Msg | undefined): { from: "session" | "agent"; name: string; mode?: string; text: string } | null {
  let m = /^<fleet-message from="([^"]*)">\n?([\s\S]*?)\n?<\/fleet-message>/.exec(text);
  if (m) return { from: "session", name: m[1], text: m[2] };
  m = /^<fleet-question from="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/fleet-question>/.exec(text);
  if (m) return { from: "session", name: m[1], text: m[2].replace(/\n?Ответь инструментом fleet\.answer[\s\S]*$/, "") };
  m = /^<cross-session-message([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(text);
  if (m) return { from: "session", name: /from-name="([^"]*)"/.exec(m[1])?.[1] ?? "", mode: /from-mode="([^"]*)"/.exec(m[1])?.[1], text: m[2] };
  m = /^<agent-message from-name="([^"]*)">\n?([\s\S]*?)\n?<\/agent-message>/.exec(text);
  if (m) return { from: "agent", name: m[1], text: m[2] };
  if (origin?.kind === "peer") return { from: "session", name: String(origin.name ?? origin.from ?? ""), text };
  return null;
}

const contextOf = (u: Msg | undefined) => (u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0);
const taskIcon = (type: unknown) => (type === "local_bash" ? "terminal" : "bot");

/** sub — шаги субагента в его карточке: без плашек ленты и без задания. */
export function fold(msgs: readonly Msg[], sub = false): View {
  const v: View = { rows: [], tools: {}, tasks: {}, compacting: false };
  const seen = new Set<string>();
  const replies = new Map<string, Extract<Row, { k: "reply" }>>();
  const early = new Map<string, { content: unknown; error: boolean }>();
  const ended = new Set<string>();
  const retracted = new Set<string>(msgs.flatMap((m) => (m.subtype === "model_refusal_fallback" ? (m.retracted_message_uuids ?? m.retractedMessageUuids ?? []) : [])));
  let boundary: Extract<Row, { k: "sys" }> | null = null;
  let cost = 0;
  let n = 0;
  const push = <R extends Row = Row>(r: Draft): R => {
    const row = { key: `r${n++}`, ...r } as R;
    v.rows.push(row);
    return row;
  };
  const last = () => v.rows.at(-1);
  const ban = (tone: "bad" | "wait", icon: string, title: string, body?: string) => !sub && push({ k: "ban", tone, icon, title, ...(body ? { body } : {}) });
  const fail = (body?: string) => ban("bad", "x", "Ошибка", body);

  const reply = (id: string) => {
    let r = replies.get(id);
    if (!r) {
      r = push<Extract<Row, { k: "reply" }>>({ k: "reply", id, parts: [], done: false });
      replies.set(id, r);
    }
    return r;
  };
  const freeze = () => {
    for (const r of replies.values()) {
      if (r.liveThink) r.parts.push({ k: "think", text: r.liveThink });
      if (r.liveText) r.parts.push({ k: "text", text: r.liveText });
      r.liveThink = r.liveText = undefined;
      r.done = true;
    }
    v.thinking = undefined;
  };
  const tool = (id: string, name: string, input: Msg) => {
    const t: Tool = { id, name, input: input ?? {}, sub: [], ...(early.has(id) ? { result: early.get(id) } : {}) };
    if (t.input.run_in_background) t.bg = true;
    v.tools[id] = t;
    return t;
  };
  const task = (m: Msg): Task => (v.tasks[m.task_id] ??= { id: m.task_id, status: "running", bg: false, since: m.timestamp ? Date.parse(m.timestamp) : (m._at ?? Date.now()) });
  const endTask = (id: string, status: string, summary?: string) => {
    if (ended.has(id)) return;
    ended.add(id);
    const t = v.tasks[id] ?? (v.tasks[id] = { id, status, bg: false, since: Date.now() });
    t.status = status;
    if (summary) t.summary = summary;
    const toolCard = t.tool ? v.tools[t.tool] : undefined;
    if (toolCard && !t.bg) return;
    if (v.rows.some((r) => r.k === "task" && r.id === id)) return;
    const [w, tone] = taskEnd(status);
    push({ k: "line", icon: taskIcon(t.type), text: w, dim: t.description || t.summary ? ` · ${t.description || t.summary}` : undefined, tone, end: id });
  };
  /** Модель сессии; строку смены даёт только init. */
  const model = (id: unknown, line = false) => {
    if (!id) return;
    const was = v.model;
    v.model = String(id);
    if (line && was && sameModel(was) !== sameModel(id)) push({ k: "sys", icon: "sparkles", text: `модель: ${modelName(was)} → ${modelName(id)}` });
  };

  for (const m of msgs) {
    if (m.uuid) {
      if (seen.has(m.uuid) || retracted.has(m.uuid)) continue;
      seen.add(m.uuid);
    }
    const parent = m.parent_tool_use_id;
    if (parent && !sub) {
      const owner = v.tools[parent];
      if (owner) owner.sub.push(m);
      continue;
    }
    if (m.type === "user" || m.type === "assistant") v.hint = undefined;

    switch (m.type) {
      case "assistant": {
        const msg = m.message ?? {};
        const refused = m.isApiErrorMessage && msg.stop_reason === "refusal";
        if (refused) {
          const prev = last();
          const body = area(msg.stop_details?.category) ? `Область: ${area(msg.stop_details?.category)}` : undefined;
          if (!(prev?.k === "ban" && prev.refusal) && !sub) push({ k: "ban", tone: "bad", icon: "shield-off", title: `${modelName(msg.model)} отказалась отвечать`, refusal: true, ...(body ? { body } : {}) });
        } else if (m.error && typeof m.error === "string") fail(apiError(m.error));
        if (msg.model) model(msg.model);
        const blocks = (msg.content ?? []) as Msg[];
        if (!blocks.length) break;
        const r = reply(msg.id ?? m.uuid);
        r.liveText = r.liveThink = undefined;
        for (const b of blocks) {
          if (b.type === "text" && b.text?.trim()) r.parts.push(/^\s*<!doctype html/i.test(b.text) ? { k: "doc", text: b.text } : { k: "text", text: b.text });
          else if (b.type === "thinking" || b.type === "redacted_thinking") {
            const prev = r.parts.at(-1);
            if (prev?.k === "think") prev.text += b.thinking ?? "";
            else r.parts.push({ k: "think", text: b.thinking ?? "", ...(b.type === "redacted_thinking" ? { redacted: true } : {}) });
          } else if (b.type === "tool_use" || b.type === "server_tool_use") {
            tool(b.id, b.name, b.input);
            r.parts.push({ k: "tool", id: b.id });
          }
        }
        if (!r.parts.length && !msg.id) v.rows.splice(v.rows.indexOf(r), 1);
        break;
      }
      case "stream_event": {
        const e = m.event ?? {};
        if (e.type === "message_start" && e.message?.id) {
          const r = reply(e.message.id);
          r.done = false;
          replies.set("__live", r);
        } else if (e.type === "content_block_delta") {
          const r = replies.get("__live");
          if (!r) break;
          if (e.delta?.type === "text_delta") r.liveText = (r.liveText ?? "") + e.delta.text;
          if (e.delta?.type === "thinking_delta") r.liveThink = (r.liveThink ?? "") + e.delta.thinking;
        }
        break;
      }
      case "user": {
        const content = m.message?.content;
        if (Array.isArray(content))
          for (const b of content as Msg[])
            if (b?.type === "tool_result") {
              const res = { content: b.content, error: !!b.is_error };
              if (v.tools[b.tool_use_id]) v.tools[b.tool_use_id].result = res;
              else early.set(b.tool_use_id, res);
              if (typeof b.content === "string" && /Command running in background/.test(b.content) && v.tools[b.tool_use_id]) v.tools[b.tool_use_id].bg = true;
            }
        const raw = textOf(content);
        if (m.isCompactSummary) {
          const text = summaryText(raw);
          const b = boundary as Extract<Row, { k: "sys" }> | null;
          if (b && !sub) {
            Object.assign(b, { k: "sum", head: b.text, text, bound: true });
            boundary = null;
          } else push({ k: "sum", head: "контекст сжат", text, bound: false });
          break;
        }
        const pics = picsOf(content);
        const text = strip(raw);
        if (!text && !pics.length) break;
        if (sub || m.isMeta) break;
        const peer = peerOf(text, m.origin);
        if (m.isSynthetic && !peer) break;
        if (/^Caveat:/.test(text)) break;
        if (/^\[Request interrupted by user/.test(text)) {
          const when = m.timestamp ? Date.parse(m.timestamp) : m._at;
          push({ k: "sys", icon: "square", text: when ? `прервано · ${at(when)}` : "прервано", tone: "wait" });
          break;
        }
        const notice = tag(text, "task-notification");
        if (notice !== undefined) {
          endTask(tag(notice, "task-id") ?? "", tag(notice, "status") ?? "", tag(notice, "summary"));
          break;
        }
        const out = tag(text, "local-command-stdout");
        if (out !== undefined) {
          const cmd = [...v.rows].reverse().find((r) => r.k === "cmd" && r.out === undefined);
          if (cmd && cmd.k === "cmd") cmd.out = out.trim();
          break;
        }
        if (tag(text, "local-command-stderr") !== undefined) break;
        const name = tag(text, "command-name") ?? tag(text, "command-message");
        const own = /^\/[\w:.-]+$/.exec(text)?.[0];
        if (name !== undefined || own) {
          const args = tag(text, "command-args")?.trim();
          const cmd = `${(name ?? own)!.startsWith("/") ? "" : "/"}${name ?? own}${args ? ` ${args}` : ""}`;
          const prev = last();
          if (prev?.k === "cmd" && prev.name === cmd) break;
          if (prev?.k === "line" && prev.out) {
            v.rows.pop();
            push({ k: "cmd", name: cmd, out: prev.text });
          } else push({ k: "cmd", name: cmd });
          break;
        }
        if (peer) {
          push({ k: "in", from: peer.from, name: peer.name, text: peer.text.replace(/\n?\(Задача от родителя [^)]*\)\s*$/, ""), ...(peer.mode ? { mode: peer.mode } : {}) });
          break;
        }
        push({ k: "me", uuid: m.uuid, text, pics });
        break;
      }
      case "result": {
        freeze();
        v.running = false;
        const prev = last();
        if (m.is_error) {
          if (prev?.k === "sys" && prev.icon === "square") break;
          const why = m.result || (m.errors?.length ? m.errors.join("; ") : undefined);
          push({ k: "res", err: m.subtype === "success" ? "success" : endWhy(m.subtype), why, parts: [] });
          break;
        }
        const total = m.total_cost_usd;
        const spent = typeof total === "number" ? (total >= cost ? total - cost : total) : undefined;
        if (typeof total === "number") cost = total;
        const parts = ["ход закончен", m.duration_ms ? duration(m.duration_ms) : "", m.num_turns ? steps(m.num_turns) : "", spent !== undefined ? money(spent) : "", contextOf(m.usage) ? `${kilo(contextOf(m.usage))} в контексте` : ""].filter(Boolean);
        push({ k: "res", parts });
        break;
      }
      case "rate_limit_event": {
        const i = m.rate_limit_info ?? {};
        if (i.status !== "allowed_warning" && i.status !== "rejected") break;
        const name = LIMIT_NAMES[i.rateLimitType] ?? i.rateLimitType;
        const body = name ? `${name}${i.resetsAt ? `, сброс в ${at(i.resetsAt)}` : ""}` : undefined;
        ban("wait", "gauge", i.status === "rejected" ? "Лимит подписки исчерпан" : "Лимит подписки скоро кончится", body);
        break;
      }
      case "auth_status":
        if (m.error) fail(String(m.error));
        break;
      case "tool_progress":
        if (v.tools[m.tool_use_id]) v.tools[m.tool_use_id].elapsed = m.elapsed_time_seconds;
        break;
      case "tool_use_summary": {
        const id = (m.preceding_tool_use_ids ?? []).at(-1);
        if (v.tools[id]) v.tools[id].note = m.summary;
        break;
      }
      case "prompt_suggestion":
        v.hint = m.suggestion;
        break;
      case "x-message":
        push({ k: "in", from: "owner", name: "", text: m.text ?? "", at: m.at, push: !!m.push });
        break;
      case "x-account":
        push({ k: "sys", icon: "repeat", text: `аккаунт: ${m.from} → ${m.to}`, tone: "swap" });
        break;
      case "conversation_reset":
        push({ k: "sys", icon: "rotate-ccw", text: "разговор начат заново" });
        break;
      case "system":
        system(m);
        break;
    }
  }

  function system(m: Msg) {
    switch (m.subtype) {
      case "init":
        model(m.model, true);
        break;
      case "status":
        v.compacting = m.status === "compacting";
        if (m.compact_result === "failed") fail(`Сжать контекст не вышло${m.compact_error ? `: ${m.compact_error}` : ""}`);
        break;
      case "compact_boundary": {
        v.compacting = false;
        const meta = m.compact_metadata ?? m.compactMetadata ?? {};
        const pre = meta.pre_tokens ?? meta.preTokens;
        const post = meta.post_tokens ?? meta.postTokens;
        const head = `контекст сжат${pre ? ` · ${kilo(pre)}` : ""}${post ? ` → ${kilo(post)}` : ""}`;
        const sum = [...v.rows].reverse().find((r) => r.k === "sum" && !r.bound);
        if (sum && sum.k === "sum") Object.assign(sum, { head, bound: true });
        else boundary = push<Extract<Row, { k: "sys" }>>({ k: "sys", icon: "archive", text: head });
        break;
      }
      case "api_retry": {
        const prev = last();
        const why = m.error ?? m.error_status;
        const text = `повтор запроса к API · ${m.attempt} из ${m.max_retries}${why ? ` · ${why}` : ""}${m.retry_delay_ms ? ` · через ${Math.round(m.retry_delay_ms / 1000)} с` : ""}`;
        if (prev?.k === "sys" && prev.retry) prev.text = text;
        else push({ k: "sys", icon: "refresh-cw", text, tone: "wait", retry: true });
        break;
      }
      case "hook_response": {
        const failed = m.outcome === "error" || (typeof m.exit_code === "number" && m.exit_code !== 0);
        if (!failed) break;
        const why = String(m.stderr || m.output || "").trim().slice(0, 300);
        push({ k: "line", icon: "anchor", tone: "wait", text: `Хук ${m.hook_name} не сработал${typeof m.exit_code === "number" ? ` (код ${m.exit_code})` : ""}`, dim: why ? `: ${why}` : undefined });
        break;
      }
      case "memory_recall": {
        const names = (m.memories ?? []).map((x: Msg) => String(x.path ?? "").split(/[\\/]/).pop());
        if (names.length) push({ k: "line", icon: "book-open", text: `Из памяти: ${names.join(", ")}` });
        break;
      }
      case "informational":
        if (m.level === "warning") ban("wait", "info", m.content);
        else push({ k: "line", icon: "info", text: m.content });
        break;
      case "notification":
        if (m.priority === "high" || m.priority === "immediate") ban("wait", "bell", m.text);
        else push({ k: "line", icon: "bell", text: m.text });
        break;
      case "permission_denied":
        push({ k: "line", icon: "ban", text: `Отклонено правилами: ${m.tool_name}${m.message ? ` — ${m.message}` : ""}` });
        break;
      case "files_persisted": {
        const ok = (m.files ?? []).map((f: Msg) => f.filename).join(", ");
        const bad = (m.failed ?? []).map((f: Msg) => `${f.filename}: ${f.error}`).join(", ");
        push({ k: "line", icon: "file-up", text: `Файлы сохранены: ${ok}${bad ? ` · Не сохранились: ${bad}` : ""}`, tone: bad ? "bad" : undefined });
        break;
      }
      case "mirror_error":
        fail(m.error);
        break;
      case "plugin_install":
        if (m.status === "failed") fail(`Плагин не установился${m.name ? ` (${m.name})` : ""}${m.error ? `: ${m.error}` : ""}`);
        break;
      case "model_fallback":
        ban("wait", "shuffle", `${modelName(m.original_model)} ${fallbackWhy(m.trigger)} — этот ход отвечает ${modelName(m.fallback_model)}`);
        break;
      case "model_refusal_fallback": {
        const to = modelName(m.fallback_model ?? m.fallbackModel);
        const why = area(m.api_refusal_category);
        const body = [m.scope === "local" ? "Только этот ответ: модель сессии прежняя" : `Дальше сессия идёт на ${to}`, why && `Область: ${why}`, m.api_refusal_explanation].filter(Boolean).join(". ");
        ban("wait", "shuffle", `${modelName(m.original_model ?? m.originalModel)} отказалась — ответ переписан моделью ${to}`, body);
        break;
      }
      case "model_refusal_no_fallback": {
        const edit = m.refused_user_message_uuid ?? m.refusedUserMessageUuid;
        const prev = [...v.rows].reverse().find((r) => r.k === "ban" && r.refusal);
        const why = m.api_refusal_explanation;
        if (prev && prev.k === "ban") {
          prev.body = [prev.body, why].filter(Boolean).join(". ") || undefined;
          prev.edit = edit;
        } else if (!sub) push({ k: "ban", tone: "bad", icon: "shield-off", title: `${modelName(m.original_model ?? m.originalModel)} отказалась отвечать`, refusal: true, edit, ...(why ? { body: why } : {}) });
        break;
      }
      case "task_started": {
        const t = task(m);
        Object.assign(t, { tool: m.tool_use_id, description: m.description, type: m.task_type, bg: !!m.is_backgrounded });
        if (t.tool && v.tools[t.tool]) v.tools[t.tool].task = t.id;
        if (!t.tool) push({ k: "task", id: t.id });
        break;
      }
      case "task_progress": {
        const t = task(m);
        if (m.summary) t.summary = m.summary;
        if (m.last_tool_name) t.last = m.last_tool_name;
        if (m.usage?.tool_uses !== undefined) t.uses = m.usage.tool_uses;
        break;
      }
      case "task_updated": {
        const t = task(m);
        const p = m.patch ?? {};
        if (p.is_backgrounded !== undefined) t.bg = p.is_backgrounded;
        if (p.status && p.status !== "running") {
          t.status = p.status;
          ended.add(t.id);
        }
        break;
      }
      case "task_notification":
        endTask(m.task_id, m.status, m.summary);
        break;
      case "background_tasks_changed": {
        const now = new Set<string>();
        for (const x of m.tasks ?? []) {
          const t = task(x);
          now.add(t.id);
          Object.assign(t, { bg: true, ...(x.description ? { description: x.description } : {}), ...(x.task_type ? { type: x.task_type } : {}) });
        }
        for (const t of Object.values(v.tasks)) if (t.bg && t.status === "running" && !now.has(t.id)) t.status = "gone";
        break;
      }
      case "session_state_changed":
        v.running = m.state === "running";
        if (m.state === "idle") v.thinking = undefined;
        break;
      case "thinking_tokens":
        v.thinking = m.estimated_tokens;
        break;
      case "local_command_output": {
        const text = String(m.content ?? "").trim();
        const cmd = [...v.rows].reverse().find((r) => r.k === "cmd" && r.out === undefined);
        if (cmd && cmd.k === "cmd") cmd.out = text;
        else push({ k: "line", icon: "zap", text, out: true });
        break;
      }
    }
  }

  v.rows = v.rows.filter((r) => r.k !== "reply" || r.parts.length || r.liveText || r.liveThink);
  const todo = Object.values(v.tools).filter((t) => t.name === "TodoWrite").at(-1);
  if (todo) v.todos = todo.input.todos ?? [];
  return v;
}
