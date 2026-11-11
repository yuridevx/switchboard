// Запрос Anthropic Messages → запрос Meta Responses (перенос из museclaude). Meta принимает только tool_choice auto и без store
// помнит ход только из input: каждый ход повторяется целиком, рассуждения тоже — так делает сам Muse CLI.
import { SEARCH_TOOL, resultsText, searchTool, type SearchConfig } from "./search.ts";

type Json = Record<string, any>;

/** Рассуждение Meta ездит через клиента в подписи блока thinking: следующий запрос возвращает его как есть. */
const SIG_PREFIX = "meta1.";
/** Поиск, который ведёт прокси, клиент видит как server_tool_use с этим началом id. */
export const SRV_PREFIX = "srvtoolu_";

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_EFFORT = "high";

export function encodeSignature(item: Json): string {
  const payload: Json = { i: item.id };
  if (item.encrypted_content) payload.e = item.encrypted_content;
  return SIG_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeSignature(sig: unknown): { i: string; e?: string } | null {
  if (typeof sig !== "string" || !sig.startsWith(SIG_PREFIX)) return null;
  try {
    const p = JSON.parse(Buffer.from(sig.slice(SIG_PREFIX.length), "base64url").toString("utf8"));
    return p?.i ? p : null;
  } catch {
    return null;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return ((content as Json[]) ?? [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

const dataUrl = (mediaType: string, data: string) => `data:${mediaType};base64,${data}`;

function imagePart(block: Json): Json {
  const s = block.source ?? {};
  if (s.type === "base64") return { type: "input_image", image_url: dataUrl(s.media_type, s.data) };
  if (s.type === "url") return { type: "input_image", image_url: s.url };
  return { type: "input_text", text: `[image omitted: unsupported source type ${s.type}]` };
}

function documentParts(block: Json): Json[] {
  const s = block.source ?? {};
  const title = block.title ? `Document: ${block.title}\n` : "";
  if (s.type === "base64" && s.media_type === "application/pdf") return [{ type: "input_file", filename: `${block.title ?? "document"}.pdf`, file_data: dataUrl(s.media_type, s.data) }];
  if (s.type === "base64") return [{ type: "input_text", text: title + Buffer.from(s.data, "base64").toString("utf8") }];
  if (s.type === "text") return [{ type: "input_text", text: title + s.data }];
  if (s.type === "content") return ((s.content ?? []) as Json[]).map((c) => (c.type === "image" ? imagePart(c) : { type: "input_text", text: title + (c.text ?? "") }));
  if (s.type === "url") return [{ type: "input_text", text: `${title}[document at ${s.url}]` }];
  return [{ type: "input_text", text: `${title}[document omitted: unsupported source type ${s.type}]` }];
}

/** Чего Meta не выражает — остаётся текстом, а не пропадает молча. */
const fallbackText = (block: Json): Json => ({ type: "input_text", text: `[${block.type}] ${JSON.stringify(block)}` });

function userPart(block: Json): Json[] {
  switch (block.type) {
    case "text":
      return block.text ? [{ type: "input_text", text: block.text }] : [];
    case "image":
      return [imagePart(block)];
    case "document":
      return documentParts(block);
    case "search_result":
      return [{ type: "input_text", text: `Search result: ${block.title ?? ""} (${block.source ?? ""})\n${textOf(block.content)}` }];
    default:
      return [fallbackText(block)];
  }
}

/** Ответ инструмента: строкой, если весь текст (как шлёт Muse CLI), иначе списком input_text и input_image. */
function toolResultOutput(block: Json): string | Json[] {
  const parts: Json[] = [];
  if (block.is_error) parts.push({ type: "input_text", text: "[tool execution failed]" });
  const c = block.content;
  if (typeof c === "string") {
    if (c) parts.push({ type: "input_text", text: c });
  } else {
    for (const p of (c ?? []) as Json[]) {
      if (p.type === "tool_reference") parts.push({ type: "input_text", text: `Tool \`${p.tool_name}\` is now loaded and can be called.` });
      else parts.push(...userPart(p));
    }
  }
  if (!parts.length) return "(no output)";
  if (parts.every((p) => p.type === "input_text")) return parts.map((p) => p.text).join("\n");
  return parts;
}

type State = { messageEffort: string | null; webSearch: SearchConfig | null; droppedTools: string[] };

function convertMessages(messages: Json[] | undefined, state: State): Json[] {
  const input: Json[] = [];
  for (const m of messages ?? []) {
    if (m.output_config?.effort) state.messageEffort = m.output_config.effort;
    const blocks: Json[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    if (m.role === "system") {
      const text = textOf(blocks);
      if (text) input.push({ type: "message", role: "developer", content: text });
      continue;
    }
    if (m.role === "user") {
      const parts: Json[] = [];
      for (const b of blocks) {
        if (b.type === "tool_result") input.push({ type: "function_call_output", call_id: b.tool_use_id, output: toolResultOutput(b) });
        else if (b.type !== "web_search_tool_result") parts.push(...userPart(b));
      }
      if (parts.length) input.push({ type: "message", role: "user", content: parts });
      continue;
    }
    for (const b of blocks) {
      switch (b.type) {
        case "thinking":
        case "redacted_thinking": {
          // чужие подписи (настоящий thinking Anthropic) и незаконченное рассуждение Meta не принимает
          const carried = decodeSignature(b.signature ?? b.data);
          if (carried?.e) input.push({ type: "reasoning", id: carried.i, encrypted_content: carried.e, summary: [] });
          break;
        }
        case "text":
          if (b.text) input.push({ type: "message", role: "assistant", content: b.text });
          break;
        case "tool_use":
          input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
          break;
        // прошлые поиски: с поиском через прокси — вызов функции и её ответ; без — заметкой, у Meta нет такого элемента
        case "server_tool_use":
          if (b.name !== "web_search") break;
          if (state.webSearch) input.push({ type: "function_call", call_id: b.id, name: SEARCH_TOOL, arguments: JSON.stringify(b.input ?? {}) });
          else if (b.input?.query) input.push({ type: "message", role: "assistant", content: `(searched the web for: ${b.input.query})` });
          break;
        case "web_search_tool_result":
          if (state.webSearch) input.push({ type: "function_call_output", call_id: b.tool_use_id, output: resultsText(b) });
          else if (Array.isArray(b.content) && b.content.length) input.push({ type: "message", role: "assistant", content: `(web search results:\n${resultsText(b)})` });
          break;
        default:
          input.push({ type: "message", role: "assistant", content: JSON.stringify(b) });
      }
    }
  }
  return input;
}

/** Инструменты, которые загрузил ToolSearch: у Meta нет defer_loading, загруженные идут обычными, остальные не идут. */
function loadedToolNames(messages: Json[] | undefined): Set<string> {
  const names = new Set<string>();
  for (const m of messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Json[]) {
      if (b?.type !== "tool_result" || !Array.isArray(b.content)) continue;
      for (const p of b.content as Json[]) if (p?.type === "tool_reference" && p.tool_name) names.add(p.tool_name);
    }
  }
  return names;
}

function convertTools(tools: Json[] | undefined, state: State, loaded: Set<string>): Json[] {
  const out: Json[] = [];
  for (const t of tools ?? []) {
    if (t.defer_loading && !loaded.has(t.name)) continue;
    const type: string = t.type ?? "custom";
    if (type.startsWith("web_search")) {
      out.push(searchTool);
      continue;
    }
    if (type !== "custom") {
      // инструменты Anthropic без пары у Meta: bash_*, text_editor_*, code_execution_*, web_fetch_*, computer_*, memory_*
      state.droppedTools.push(t.name ?? type);
      continue;
    }
    const { $schema: _s, ...parameters } = t.input_schema ?? { type: "object", properties: {} };
    out.push({ type: "function", name: t.name, description: t.description ?? "", parameters, strict: t.strict === true });
  }
  return out;
}

/** Meta принимает только tool_choice auto: прочие режимы — словами в instructions. */
function toolChoiceInstruction(tc: Json | undefined): string | null {
  if (!tc || tc.type === "auto") return null;
  if (tc.type === "any") return "You must respond by calling at least one of the available tools.";
  if (tc.type === "tool") return `You must respond by calling the tool \`${tc.name}\`.`;
  if (tc.type === "none") return "Do not call any tools in this response; answer with text only.";
  return null;
}

function webSearchConfig(tools: Json[] | undefined): SearchConfig | null {
  const t = (tools ?? []).find((x) => (x.type ?? "").startsWith("web_search"));
  if (!t) return null;
  return { maxUses: t.max_uses ?? null, allowedDomains: t.allowed_domains ?? null, blockedDomains: t.blocked_domains ?? null };
}

export function effortFromBudget(budget: number): string {
  if (budget <= 1024) return "minimal";
  if (budget <= 4096) return "low";
  if (budget <= 16000) return "medium";
  if (budget <= 32000) return "high";
  if (budget <= 64000) return "xhigh";
  return "max";
}

export function normalizeEffort(e: unknown): string | null {
  if (!e) return null;
  const v = String(e).toLowerCase();
  if (v === "none") return "minimal";
  return EFFORTS.includes(v) ? v : null;
}

/** Claude Code кладёт id сессии в metadata.user_id строкой JSON. */
function sessionIdOf(req: Json): string | null {
  try {
    return JSON.parse(req.metadata?.user_id ?? "null")?.session_id ?? null;
  } catch {
    return null;
  }
}

function textFormat(req: Json): Json | null {
  const f = req.output_config?.format ?? req.output_format;
  if (!f || f.type !== "json_schema") return null;
  const schema = f.schema ?? f.json_schema?.schema ?? f.json_schema;
  return { text: { format: { type: "json_schema", name: "output", schema, strict: schema?.additionalProperties === false } } };
}

function cacheKey(req: Json): string | null {
  const uid = req.metadata?.user_id;
  if (!uid) return null;
  const sid = sessionIdOf(req);
  return sid ? `ccp:${sid}` : `ccp:${String(uid).slice(0, 120)}`;
}

export type MetaCtx = {
  requestedModel: string;
  metaModel: string;
  effort: string;
  showThinking: boolean;
  stopSequences: string[];
  webSearch: SearchConfig | null;
  droppedTools: string[];
  sessionId: string | null;
};

/** Модель — как её назвал claude: какими моделями идёт ключ, говорит env ключа флота, карты моделей нет. */
export function toMetaRequest(req: Json): { body: Json; ctx: MetaCtx } {
  const state: State = { messageEffort: null, webSearch: webSearchConfig(req.tools), droppedTools: [] };
  const input = convertMessages(req.messages, state);
  const tools = convertTools(req.tools, state, loadedToolNames(req.messages));
  // строка учёта Claude Code в system — дело клиента
  const system = typeof req.system === "string" ? req.system : textOf(((req.system ?? []) as Json[]).filter((b) => !/^x-anthropic-billing-header:/.test(b.text ?? "")));
  const instructions = [system, toolChoiceInstruction(req.tool_choice)].filter(Boolean).join("\n\n");
  const thinking = req.thinking ?? {};
  let effort =
    normalizeEffort(state.messageEffort) ??
    normalizeEffort(req.output_config?.effort) ??
    (thinking.type === "enabled" && thinking.budget_tokens ? effortFromBudget(thinking.budget_tokens) : null) ??
    DEFAULT_EFFORT;
  if (thinking.type === "disabled") effort = "minimal";
  // thinking входит в max_tokens у Anthropic, как и в max_output_tokens у Meta
  const maxTokens = Math.max(16, Math.min(req.max_tokens ?? 32000, 128000));
  if (maxTokens < 2048 && EFFORTS.indexOf(effort) > EFFORTS.indexOf("low")) effort = "low";
  const showThinking = thinking.display ? thinking.display === "summarized" : thinking.type === "enabled";
  const key = cacheKey(req);
  const body: Json = {
    model: req.model,
    input,
    ...(instructions ? { instructions } : {}),
    max_output_tokens: maxTokens,
    store: false,
    ...(req.tool_choice?.disable_parallel_tool_use ? { parallel_tool_calls: false } : {}),
    ...(tools.length ? { tools } : {}),
    reasoning: { effort, ...(showThinking ? { summary: "auto" } : {}) },
    ...(textFormat(req) ?? {}),
    include: ["reasoning.encrypted_content"],
    ...(key ? { prompt_cache_key: key } : {}),
    stream: true,
  };
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;
  return {
    body,
    ctx: {
      requestedModel: req.model,
      metaModel: body.model,
      effort,
      showThinking,
      stopSequences: ((req.stop_sequences ?? []) as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0),
      webSearch: state.webSearch,
      droppedTools: state.droppedTools,
      sessionId: sessionIdOf(req),
    },
  };
}

/** Оценка токенов для count_tokens: счёта у Meta нет. */
export function estimateTokens(metaBody: Json): number {
  let chars = (metaBody.instructions ?? "").length + JSON.stringify(metaBody.tools ?? []).length;
  let images = 0;
  for (const item of metaBody.input as Json[]) {
    chars += JSON.stringify(item, (_k, v) => {
      if (typeof v === "string" && v.startsWith("data:")) {
        images++;
        return "";
      }
      return v;
    }).length;
  }
  return Math.ceil(chars / 3.8) + images * 1500;
}
