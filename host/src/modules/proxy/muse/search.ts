// Веб-поиск для инструмента web_search Anthropic через /muse-code/search Meta — поиск самого Muse CLI (перенос из museclaude).
// Модель получает функцию web_search; позвала — прокси ищет, отдаёт клиенту server_tool_use и web_search_tool_result,
// модели — результаты ответом функции, и то же сообщение Anthropic идёт дальше.
import { apiHeaders } from "./headers.ts";
import { send, textOf } from "../upstream.ts";

type Json = Record<string, any>;
export type SearchConfig = { maxUses: number | null; allowedDomains: string[] | null; blockedDomains: string[] | null };
export type Creds = { key: string; base: string; version: string };

export const SEARCH_TOOL = "web_search";
const MAX_RESULTS = 10;
const SNIPPET_CHARS = 1200;

export const searchTool = {
  type: "function",
  name: SEARCH_TOOL,
  description:
    "Search the web for current information. Returns the top results with title, URL, date and a text snippet. " +
    "Use focused queries; search again with a refined query if the results are not enough.",
  parameters: { type: "object", properties: { query: { type: "string", description: "The search query" } }, required: ["query"], additionalProperties: false },
  strict: false,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Домен списка Anthropic — сам домен и его поддомены. */
const matches = (host: string, domain: string) => {
  const d = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return host === d || host.endsWith(`.${d}`);
};

function allowed(url: string, cfg: SearchConfig): boolean {
  const host = hostOf(url);
  if (cfg.allowedDomains?.length && !cfg.allowedDomains.some((d) => matches(host, d))) return false;
  if (cfg.blockedDomains?.length && cfg.blockedDomains.some((d) => matches(host, d))) return false;
  return true;
}

const pageAge = (epoch: number | undefined) => (epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : null);

/** Поиск: content — для блока web_search_tool_result (список или ошибка), text — что прочтёт модель ответом функции. */
export async function runSearch(creds: Creds, query: string, cfg: SearchConfig, usedSoFar: number, signal: AbortSignal): Promise<{ error: boolean; content: Json | Json[]; text: string }> {
  if (cfg.maxUses != null && usedSoFar >= cfg.maxUses) return { error: true, content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }, text: "Error: the web search limit for this request has been reached." };
  if (!query || typeof query !== "string") return { error: true, content: { type: "web_search_tool_result_error", error_code: "invalid_tool_input" }, text: "Error: web_search needs a non-empty `query`." };
  let res;
  try {
    res = await send(`${new URL(creds.base).origin}/muse-code/search`, { method: "POST", headers: apiHeaders(creds.key, creds.version, { "content-type": "application/json" }), body: Buffer.from(JSON.stringify({ query })), signal, decode: true });
  } catch (err) {
    return { error: true, content: { type: "web_search_tool_result_error", error_code: "unavailable" }, text: `Error: search unavailable (${(err as Error).message}).` };
  }
  if (res.status < 200 || res.status >= 300) {
    await textOf(res).catch(() => "");
    return { error: true, content: { type: "web_search_tool_result_error", error_code: res.status === 429 ? "too_many_requests" : "unavailable" }, text: `Error: search failed (HTTP ${res.status}).` };
  }
  let j: Json = {};
  try {
    j = JSON.parse(await textOf(res));
  } catch {
    // пустой ответ — результатов нет
  }
  const results = ((j.results ?? []) as Json[]).filter((r) => r?.url && allowed(r.url, cfg)).slice(0, MAX_RESULTS);
  const content = results.map((r) => ({
    type: "web_search_result",
    url: r.url,
    title: r.title || r.url,
    encrypted_content: Buffer.from(JSON.stringify({ s: r.snippet ?? "" })).toString("base64url"),
    page_age: pageAge(r.page_last_modified),
  }));
  const text = results.length
    ? results
        .map((r, i) => {
          const date = pageAge(r.page_last_modified);
          const snippet = String(r.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
          return `[${i + 1}] ${r.title || r.url}\nURL: ${r.url}${date ? `\nDate: ${date}` : ""}${snippet ? `\n${snippet}` : ""}`;
        })
        .join("\n\n")
    : "No results.";
  return { error: false, content, text };
}

function snippetOf(result: Json): string {
  try {
    return JSON.parse(Buffer.from(result.encrypted_content ?? "", "base64url").toString("utf8")).s ?? "";
  } catch {
    return "";
  }
}

/** Текст для модели из блока web_search_tool_result, вернувшегося в истории. */
export function resultsText(block: Json): string {
  if (!Array.isArray(block.content)) return `Error: ${block.content?.error_code ?? "search failed"}.`;
  if (!block.content.length) return "No results.";
  return (block.content as Json[])
    .filter((r) => r.type === "web_search_result")
    .map((r, i) => {
      const s = snippetOf(r);
      return `[${i + 1}] ${r.title ?? r.url}\nURL: ${r.url}${r.page_age ? `\nDate: ${r.page_age}` : ""}${s ? `\n${s}` : ""}`;
    })
    .join("\n\n");
}
