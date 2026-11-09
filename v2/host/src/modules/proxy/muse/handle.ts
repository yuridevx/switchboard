// Вызов модели Meta: запрос Anthropic → Responses → поток Anthropic (перенос из museclaude). Раунды — только ради поиска через прокси:
// модель просит поиск — результаты уходят ей, и то же сообщение Anthropic идёт дальше.
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { responsesHeaders } from "./headers.ts";
import { estimateTokens, toMetaRequest } from "./request.ts";
import { runSearch, type Creds } from "./search.ts";
import { MessageReducer, messageId, messageStart, replayItems, StreamTranslator } from "./stream.ts";
import { send, textOf } from "../upstream.ts";

type Json = Record<string, any>;

/** Окно muse-spark-1.3 и muse-wonder-1.0 по каталогу Meta. */
const META_CONTEXT_WINDOW = 1007997;
/** Раундов поиска через прокси в одном сообщении Anthropic. */
const MAX_SEARCH_ROUNDS = 8;
const PING_MS = 10_000;

/** Конверт ошибки Anthropic: claude повторяет по коду HTTP и сжимает разговор по словам «prompt is too long». */
export const anthropicError = (status: number, type: string, message: string) => ({ status, body: { type: "error", error: { type, message } } });

function mapUpstreamError(status: number, text: string, metaBody: Json) {
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message ?? j.detail ?? j.title ?? text;
  } catch {
    // ответ не JSON — как есть
  }
  msg = String(msg || `HTTP ${status}`).slice(0, 2000);
  if (status === 400 && /context|too long|maximum.*tokens|token limit|exceeds/i.test(msg)) return anthropicError(400, "invalid_request_error", `prompt is too long: ${estimateTokens(metaBody)} tokens > ${META_CONTEXT_WINDOW} maximum (Meta: ${msg})`);
  if (status === 400 || status === 422) return anthropicError(400, "invalid_request_error", `Meta rejected the request: ${msg}`);
  if (status === 401) return anthropicError(401, "authentication_error", `Meta API key rejected (${msg})`);
  if (status === 403) return anthropicError(403, "permission_error", msg);
  if (status === 404) return anthropicError(404, "not_found_error", msg);
  if (status === 413) return anthropicError(413, "request_too_large", msg);
  if (status === 429) return anthropicError(429, "rate_limit_error", msg);
  if (status === 503 || status === 529) return anthropicError(529, "overloaded_error", msg);
  return anthropicError(status >= 500 ? status : 500, "api_error", msg);
}

/** Квота Meta (429 rate_limit_exceeded с resets_at) — заголовками лимита Anthropic: claude пишет «лимит сессии, сброс в …», а не «сервер ограничивает». */
function quotaHeaders(status: number, text: string): Record<string, string> {
  if (status !== 429) return {};
  let err: Json | undefined;
  try {
    err = JSON.parse(text).error;
  } catch {
    return {};
  }
  if (err?.code !== "rate_limit_exceeded" || !err.resets_at) return {};
  return {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": /week/i.test(err.message ?? "") ? "seven_day" : "five_hour",
    "anthropic-ratelimit-unified-reset": String(Math.round(Number(err.resets_at))),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** События SSE как объекты. */
export async function* sseEvents(body: Readable): AsyncGenerator<Json> {
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  for await (const chunk of body) {
    buf += decoder.decode(chunk as Buffer, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (!data.length) continue;
        const payload = data.join("\n");
        data = [];
        if (payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // битое событие пропущено, как у museclaude
        }
      } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
  }
}

/** count_tokens: у Meta счёта нет — оценка. */
export function countTokens(res: ServerResponse, anth: Json): void {
  const { body } = toMetaRequest({ ...anth, max_tokens: anth.max_tokens ?? 1024 });
  sendJson(res, 200, { input_tokens: estimateTokens(body) });
}

/** Вызов модели Meta. gap — что перевод не знает: строкой в журнал Host. */
export async function messages(res: ServerResponse, anth: Json, creds: Creds, signal: AbortSignal, gap: (why: string) => void): Promise<void> {
  let meta;
  try {
    meta = toMetaRequest(anth);
  } catch (err) {
    const e = anthropicError(400, "invalid_request_error", `could not translate request: ${(err as Error).message}`);
    return sendJson(res, e.status, e.body);
  }
  const { body, ctx } = meta;
  if (ctx.droppedTools.length) gap(`инструменты без пары у Meta: ${ctx.droppedTools.join(", ")}`);
  const ac = new AbortController();
  const abort = () => ac.abort();
  signal.addEventListener("abort", abort);
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  const streaming = anth.stream === true;
  const tr = new StreamTranslator(ctx);
  const reducer = streaming ? null : new MessageReducer();
  const id = messageId();
  let ping: ReturnType<typeof setInterval> | undefined;
  let started = false;
  const emit = (ev: Json) => {
    if (streaming) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    else reducer!.push(ev);
  };
  try {
    let roundBody = body;
    let searchesRun = 0;
    for (let round = 0; ; round++) {
      let up;
      try {
        up = await send(`${creds.base}/responses`, { method: "POST", headers: responsesHeaders(creds.key, creds.version, ctx.sessionId), body: Buffer.from(JSON.stringify(roundBody)), signal: ac.signal, decode: true });
      } catch (err) {
        if (res.destroyed) return;
        const why = `cannot reach Meta: ${(err as Error).message}`;
        if (!started) {
          const e = anthropicError(502, "api_error", why);
          return sendJson(res, e.status, e.body);
        }
        tr.error = { message: why };
        break;
      }
      if (up.status < 200 || up.status >= 300) {
        const text = await textOf(up).catch(() => "");
        const e = mapUpstreamError(up.status, text, roundBody);
        if (!started) {
          const retry = up.headers["retry-after"];
          return sendJson(res, e.status, e.body, { ...(typeof retry === "string" ? { "retry-after": retry } : {}), ...quotaHeaders(up.status, text) });
        }
        tr.error = { message: e.body.error.message };
        break;
      }
      if (!started) {
        started = true;
        if (streaming) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          ping = setInterval(() => res.write(`event: ping\ndata: {"type":"ping"}\n\n`), PING_MS);
        }
        emit(messageStart(id, anth.model));
      }
      tr.status = null;
      try {
        for await (const ev of sseEvents(up.body)) {
          for (const a of tr.handle(ev)) emit(a);
          if (tr.stopSequence) {
            // клиент просил остановиться здесь: остальное не нужно
            ac.abort();
            break;
          }
        }
      } catch (err) {
        if (!tr.stopSequence) tr.error ??= { message: `upstream stream broke: ${(err as Error).message}` };
      }
      const searches = tr.takeSearches();
      if (!searches.length || tr.error || tr.stopSequence || res.destroyed) break;
      const outputs: Json[] = [];
      for (const s of searches) {
        const r = await runSearch(creds, s.query, ctx.webSearch!, searchesRun, ac.signal);
        if (!r.error) searchesRun++;
        for (const a of tr.webSearchResult(s, r.content)) emit(a);
        outputs.push({ type: "function_call_output", call_id: s.callId, output: r.text });
      }
      // в том же раунде позваны инструменты клиента: ход возвращается клиенту, он пришлёт блоки поиска со своими ответами
      if (tr.toolUses > 0 || round + 1 >= MAX_SEARCH_ROUNDS) break;
      roundBody = { ...roundBody, input: [...roundBody.input, ...replayItems(tr.lastOutput), ...outputs] };
    }
  } finally {
    clearInterval(ping);
    signal.removeEventListener("abort", abort);
  }
  if (res.destroyed) return;
  if (tr.error && tr.status !== "completed" && !tr.stopSequence) {
    const type = /rate|quota|limit/i.test(tr.error.message ?? "") ? "rate_limit_error" : "api_error";
    if (streaming) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message: tr.error.message } })}\n\n`);
      return void res.end();
    }
    return sendJson(res, 500, { type: "error", error: { type, message: tr.error.message } });
  }
  for (const a of tr.finish()) emit(a);
  if (streaming) return void res.end();
  sendJson(res, 200, reducer!.message);
}
