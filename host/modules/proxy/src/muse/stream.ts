// Поток Meta Responses → поток Anthropic Messages (перенос из museclaude):
//   reasoning → блок thinking (текст сводки — thinking_delta, если его показывают; id и encrypted_content — signature_delta)
//   message → блок text (открывается по первому тексту: пустое сообщение ничего не шлёт)
//   function_call → tool_use (аргументы — input_json_delta); web_search функцией прокси — server_tool_use
//   completed / incomplete → message_delta (stop_reason, usage) и message_stop
import { randomBytes } from "node:crypto";
import { encodeSignature, SRV_PREFIX, type MetaCtx } from "./request.ts";
import { SEARCH_TOOL } from "./search.ts";

type Json = Record<string, any>;
type Item = { kind: "thinking" | "message" | "tool" | "proxy-search" | "search"; index?: number; sentArgs?: boolean; summaryIndex?: number | null };
export type Search = { id: string; callId: string; query: string };

export const messageId = () => "msg_" + randomBytes(12).toString("hex");

export class StreamTranslator {
  ctx: MetaCtx;
  index = 0;
  items = new Map<number, Item>();
  text: { index: number; held: string } | null = null;
  toolUses = 0;
  webSearches = 0;
  stopSequence: string | null = null;
  status: string | null = null;
  incompleteReason: string | null = null;
  usage: Json | null = null;
  error: { code?: string; message: string } | null = null;
  responseId: string | null = null;
  maxStop: number;
  pendingSearches: Search[] = [];
  lastOutput: Json[] = [];

  constructor(ctx: MetaCtx) {
    this.ctx = ctx;
    this.maxStop = Math.max(0, ...ctx.stopSequences.map((s) => s.length));
  }

  /** Раунды поиска — отдельные ответы Meta, Anthropic видит одну сумму. */
  private addUsage(u: Json | undefined) {
    if (!u) return;
    const prev = this.usage ?? { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } };
    this.usage = {
      input_tokens: prev.input_tokens + (u.input_tokens ?? 0),
      output_tokens: prev.output_tokens + (u.output_tokens ?? 0),
      input_tokens_details: { cached_tokens: prev.input_tokens_details.cached_tokens + (u.input_tokens_details?.cached_tokens ?? 0) },
    };
  }

  takeSearches(): Search[] {
    const s = this.pendingSearches;
    this.pendingSearches = [];
    return s;
  }

  webSearchResult(search: Search, content: unknown): Json[] {
    this.webSearches++;
    const b = this.start({ type: "web_search_tool_result", tool_use_id: search.id, content });
    return [...b.events, this.stopBlock(b.index)];
  }

  private start(block: Json) {
    const index = this.index++;
    return { index, events: [{ type: "content_block_start", index, content_block: block }] as Json[] };
  }

  private delta = (index: number, delta: Json): Json => ({ type: "content_block_delta", index, delta });
  private stopBlock = (index: number): Json => ({ type: "content_block_stop", index });

  /** Текст идёт через фильтр стоп-строк: хвост, который ещё может стать стоп-строкой, придержан до следующего куска. */
  private textDelta(chunk: string): Json[] {
    const out: Json[] = [];
    if (this.stopSequence) return out;
    if (!this.text) {
      const { index, events } = this.start({ type: "text", text: "" });
      out.push(...events);
      this.text = { index, held: "" };
    }
    if (!this.maxStop) {
      out.push(this.delta(this.text.index, { type: "text_delta", text: chunk }));
      return out;
    }
    const buf = this.text.held + chunk;
    let cut = -1;
    for (const s of this.ctx.stopSequences) {
      const i = buf.indexOf(s);
      if (i !== -1 && (cut === -1 || i < cut)) {
        cut = i;
        this.stopSequence = s;
      }
    }
    if (cut !== -1) {
      if (cut > 0) out.push(this.delta(this.text.index, { type: "text_delta", text: buf.slice(0, cut) }));
      this.text.held = "";
      return out;
    }
    const keep = Math.min(buf.length, this.maxStop - 1);
    const emit = buf.slice(0, buf.length - keep);
    this.text.held = buf.slice(buf.length - keep);
    if (emit) out.push(this.delta(this.text.index, { type: "text_delta", text: emit }));
    return out;
  }

  private closeText(): Json[] {
    if (!this.text) return [];
    const out: Json[] = [];
    if (this.text.held) out.push(this.delta(this.text.index, { type: "text_delta", text: this.text.held }));
    out.push(this.stopBlock(this.text.index));
    this.text = null;
    return out;
  }

  /** Одно событие Meta — ноль или больше событий Anthropic. */
  handle(ev: Json): Json[] {
    const out: Json[] = [];
    const st = this.items.get(ev.output_index);
    switch (ev.type) {
      case "response.created":
      case "response.in_progress":
        this.responseId = ev.response?.id ?? this.responseId;
        break;
      case "response.output_item.added": {
        const item = ev.item ?? {};
        if (item.type === "reasoning") {
          out.push(...this.closeText());
          const { index, events } = this.start({ type: "thinking", thinking: "", signature: "" });
          out.push(...events);
          this.items.set(ev.output_index, { kind: "thinking", index, summaryIndex: null });
        } else if (item.type === "message") {
          this.items.set(ev.output_index, { kind: "message" });
        } else if (item.type === "function_call" && this.ctx.webSearch && item.name === SEARCH_TOOL) {
          // этот поиск ведёт прокси: клиенту это серверный инструмент
          out.push(...this.closeText());
          const { index, events } = this.start({ type: "server_tool_use", id: SRV_PREFIX + item.call_id, name: "web_search", input: {} });
          out.push(...events);
          this.items.set(ev.output_index, { kind: "proxy-search", index, sentArgs: false });
        } else if (item.type === "function_call") {
          out.push(...this.closeText());
          const { index, events } = this.start({ type: "tool_use", id: item.call_id, name: item.name, input: {} });
          out.push(...events);
          this.items.set(ev.output_index, { kind: "tool", index, sentArgs: false });
          this.toolUses++;
        } else if (item.type === "web_search_call") {
          out.push(...this.closeText());
          this.items.set(ev.output_index, { kind: "search" });
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (st?.kind === "thinking" && this.ctx.showThinking && ev.delta) {
          let text: string = ev.delta;
          if (ev.summary_index != null && st.summaryIndex != null && ev.summary_index !== st.summaryIndex) text = "\n\n" + text;
          if (ev.summary_index != null) st.summaryIndex = ev.summary_index;
          out.push(this.delta(st.index!, { type: "thinking_delta", thinking: text }));
        }
        break;
      case "response.output_text.delta":
        if (ev.delta) out.push(...this.textDelta(ev.delta));
        break;
      case "response.function_call_arguments.delta":
        if ((st?.kind === "tool" || st?.kind === "proxy-search") && ev.delta) {
          st.sentArgs = true;
          out.push(this.delta(st.index!, { type: "input_json_delta", partial_json: ev.delta }));
        }
        break;
      case "response.output_item.done": {
        const item = ev.item ?? {};
        if (st?.kind === "thinking") {
          out.push(this.delta(st.index!, { type: "signature_delta", signature: encodeSignature(item) }));
          out.push(this.stopBlock(st.index!));
        } else if (st?.kind === "message") {
          // сообщение без кусков несёт текст целиком в done
          if (!this.text && !this.stopSequence) {
            const full = ((item.content ?? []) as Json[]).map((c) => c.text ?? "").join("");
            if (full) out.push(...this.textDelta(full));
          }
          out.push(...this.closeText());
        } else if (st?.kind === "tool" || st?.kind === "proxy-search") {
          if (!st.sentArgs && item.arguments) out.push(this.delta(st.index!, { type: "input_json_delta", partial_json: item.arguments }));
          out.push(this.stopBlock(st.index!));
          if (st.kind === "proxy-search") {
            let query = "";
            try {
              query = JSON.parse(item.arguments || "{}").query ?? "";
            } catch {
              // запрос не JSON — поиск без строки ответит словами
            }
            this.pendingSearches.push({ id: SRV_PREFIX + item.call_id, callId: item.call_id, query });
          }
        } else if (st?.kind === "search") {
          out.push(...this.webSearchBlocks(item));
        }
        this.items.delete(ev.output_index);
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const r = ev.response ?? {};
        this.status = r.status ?? ev.type.split(".")[1];
        this.incompleteReason = r.incomplete_details?.reason ?? null;
        this.addUsage(r.usage);
        this.lastOutput = r.output ?? [];
        if (r.error) this.error = r.error;
        out.push(...this.closeText());
        break;
      }
      case "error":
        this.error = { code: ev.code, message: ev.message ?? ev.error?.message ?? JSON.stringify(ev.error ?? ev) };
        break;
      default:
        // response.content_part.*, *.done текста, границы частей сводки, response.subscription_usage и новое — нечего передавать
        break;
    }
    return out;
  }

  /** Поиск самой Meta: результаты в done (title, url, snippet), запасной источник — action.sources. */
  private webSearchBlocks(item: Json): Json[] {
    this.webSearches++;
    const id = SRV_PREFIX + String(item.id ?? randomBytes(8).toString("hex")).replace(/[^A-Za-z0-9_-]/g, "_");
    const query = item.action?.query ?? "";
    const found: Json[] = item.results?.length ? item.results : (item.action?.sources ?? []);
    const content = found
      .filter((r) => r?.url)
      .map((r) => ({ type: "web_search_result", url: r.url, title: r.title || r.url, encrypted_content: Buffer.from(JSON.stringify({ s: r.snippet ?? "" })).toString("base64url"), page_age: null }));
    const a = this.start({ type: "server_tool_use", id, name: "web_search", input: {} });
    const out = [...a.events, this.delta(a.index, { type: "input_json_delta", partial_json: JSON.stringify({ query }) }), this.stopBlock(a.index)];
    const b = this.start({ type: "web_search_tool_result", tool_use_id: id, content });
    out.push(...b.events, this.stopBlock(b.index));
    return out;
  }

  stopReason(): string {
    if (this.stopSequence) return "stop_sequence";
    if (this.toolUses > 0) return "tool_use";
    if (this.status === "incomplete" && /max_output_tokens|max_tokens/.test(this.incompleteReason ?? "")) return "max_tokens";
    return "end_turn";
  }

  anthropicUsage(): Json {
    const u = this.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const usage: Json = { input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached), cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: u.output_tokens ?? 0 };
    if (this.webSearches) usage.server_tool_use = { web_search_requests: this.webSearches };
    return usage;
  }

  finish(): Json[] {
    return [...this.closeText(), { type: "message_delta", delta: { stop_reason: this.stopReason(), stop_sequence: this.stopSequence }, usage: this.anthropicUsage() }, { type: "message_stop" }];
  }
}

/** Выход законченного раунда — вход следующего раунда того же хода, как Muse CLI повторяет свою историю. */
export function replayItems(output: Json[]): Json[] {
  const items: Json[] = [];
  for (const o of output ?? []) {
    if (o.type === "reasoning" && o.encrypted_content) items.push({ type: "reasoning", id: o.id, encrypted_content: o.encrypted_content, summary: [] });
    else if (o.type === "message") {
      const text = ((o.content ?? []) as Json[]).map((c) => c.text ?? "").join("");
      if (text) items.push({ type: "message", role: "assistant", content: text });
    } else if (o.type === "function_call") items.push({ type: "function_call", call_id: o.call_id, name: o.name, arguments: o.arguments ?? "{}" });
  }
  return items;
}

export const messageStart = (id: string, model: string): Json => ({
  type: "message_start",
  message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
});

/** События Anthropic → одно сообщение: для запроса без stream. */
export class MessageReducer {
  message: Json | null = null;
  private json = new Map<number, string>();

  push(ev: Json): void {
    switch (ev.type) {
      case "message_start":
        this.message = structuredClone(ev.message);
        break;
      case "content_block_start":
        this.message!.content[ev.index] = structuredClone(ev.content_block);
        break;
      case "content_block_delta": {
        const b = this.message!.content[ev.index];
        const d = ev.delta;
        if (d.type === "text_delta") b.text += d.text;
        else if (d.type === "thinking_delta") b.thinking += d.thinking;
        else if (d.type === "signature_delta") b.signature = d.signature;
        else if (d.type === "input_json_delta") this.json.set(ev.index, (this.json.get(ev.index) ?? "") + d.partial_json);
        break;
      }
      case "content_block_stop": {
        const raw = this.json.get(ev.index);
        if (raw !== undefined) {
          try {
            this.message!.content[ev.index].input = raw ? JSON.parse(raw) : {};
          } catch {
            this.message!.content[ev.index].input = { _raw: raw };
          }
        }
        break;
      }
      case "message_delta":
        Object.assign(this.message!, ev.delta);
        this.message!.usage = { ...this.message!.usage, ...ev.usage };
        break;
    }
  }
}
