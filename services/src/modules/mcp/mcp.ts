// Сервер MCP флота: один для сессий флота и внешнего Claude. Инструмент — запрос договора с описанием для модели;
// вызов идёт тем же входом, что POST /call. Своих инструментов и состояния нет.
// Вход — Bearer пропуска (у сессии флота — пропуск машины и позывной в x-sb-as); без живого пропуска — 401 со ссылкой на метаданные входа OAuth.
import { contract, type Frame, kindOf, machineOf, newId, parsePass, READ_MS, type RequestDef, stopwatch, toolText, within, z } from "@sb/protocol";
import type { Deps, Env } from "../../env.ts";
import { bearer, call, type handlersOf } from "../../entrance.ts";
import { log, outbound } from "../../env.ts";
import { toolLine } from "../analytics/contract.ts";
import { GUIDES, RULES, RULES_OUT } from "./guide.ts";

/** Версии протокола MCP, которые сервер понимает; первая — та, что предлагается на незнакомую. */
const KNOWN = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1024 * 1024;
export const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "www-authenticate, mcp-session-id" };
const PREFLIGHT = { ...CORS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, x-sb-as" };

export const toolName = (request: string) => request.replaceAll(".", "_");

function schemaOf(def: RequestDef): unknown {
  try {
    const { $schema: _s, ...schema } = z.toJSONSchema(def.input, { unrepresentable: "any" }) as Record<string, unknown>;
    return schema;
  } catch {
    return { type: "object" };
  }
}

/** Инструменты из договора: описание — текст хозяина запроса и пример вызова; читающим — пометка «только чтение» (Claude Code зовёт такие параллельно и повторяет после обрыва). */
export const tools = () => contract.tools().map((d) => ({ name: toolName(d.name), description: toolText(d), inputSchema: schemaOf(d), ...(d.reads ? { annotations: { readOnlyHint: true } } : {}) }));

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const IMAGES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Строка, которую модель прочитать не может: подпись размышления, шифрованное содержимое, картинка текстом — длинная, без пробелов, из знаков кодировки. */
const OPAQUE = /^[A-Za-z0-9+/_=-]{200,}$/;
/** Служебные поля событий разговора: модели они ничего не говорят. Номер события (uuid) остаётся — по нему историю листают. */
const SERVICE = new Set(["signature", "usage", "modelUsage", "stop_details", "stop_sequence", "stop_reason", "session_id", "parent_agent_id", "parent_tool_use_id", "iterations", "requestId", "context_management", "container", "caller"]);
const EVENT_TYPES = new Set(["assistant", "user", "result", "system"]);
const isEvent = (v: Record<string, unknown>) => typeof v.type === "string" && EVENT_TYPES.has(v.type) && ("message" in v || "subtype" in v || "uuid" in v);
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) ? !v.length : typeof v === "object" && !Object.keys(v as object).length);

/** Ответ инструмента — только нужное модели. Одна чистка на любой инструмент; страница ходит мимо сервера инструментов и получает ответ целиком.
 *  Везде: непрозрачные строки (кроме файлов, которые скрипт вернул сам, — поле base64). В событиях разговора: служебные поля, пустое и блоки размышлений без текста. */
export function lean(v: unknown, inEvent = false, key = ""): unknown {
  if (typeof v === "string") return key !== "base64" && OPAQUE.test(v) ? undefined : v;
  if (Array.isArray(v)) return v.map((x) => lean(x, inEvent)).filter((x) => x !== undefined && !(inEvent && (empty(x) || ((x as { type?: string }).type === "thinking" && !(x as { thinking?: string }).thinking))));
  if (!v || typeof v !== "object") return v;
  const event = inEvent || isEvent(v as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (event && SERVICE.has(k)) continue;
    const y = lean(x, event, k);
    if (y === undefined || (event && empty(y))) continue;
    out[k] = y;
  }
  return out;
}

/** Ответ инструмента для модели: текст — результат запроса после чистки; картинки среди файлов результата (скрипт положил их в $SB_OUT) идут блоками изображения, а не строкой base64. */
export function toolContent(raw: unknown): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const result = lean(raw ?? {});
  const files = (result as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [{ type: "text", text: JSON.stringify(result ?? {}) }];
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  const rest = (files as Array<{ name?: string; base64?: string }>).map((f) => {
    const mime = IMAGES[String(f.name ?? "").split(".").pop()!.toLowerCase()];
    if (!mime || typeof f.base64 !== "string") return f;
    images.push({ type: "image", data: f.base64, mimeType: mime });
    const { base64: _b, ...named } = f;
    return { ...named, shown: true };
  });
  return [{ type: "text", text: JSON.stringify({ ...(result as object), files: rest }) }, ...images];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...headers } });
const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Нет живого пропуска: 401 со ссылкой на метаданные ресурса (RFC 9728) — клиент идёт во вход OAuth. */
export function unauthorized(origin: string, why: string): Response {
  log.warn("MCP: пропуск не принят", { module: "mcp", why });
  return new Response(null, { status: 401, headers: { ...CORS, "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
}

class Unauthorized extends Error {}

export async function mcp(req: Request, env: Env, exec: ExecutionContext, handlers: ReturnType<typeof handlersOf>, deps: Deps): Promise<Response> {
  const origin = new URL(req.url).origin;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...CORS, allow: "POST" } });
  const key = bearer(req);
  if (!parsePass(key)) return unauthorized(origin, "нет пропуска");
  const text = await req.text();
  if (text.length > MAX_BODY) return json(rpcError(null, -32600, "тело больше 1 МБ"), 413);
  let body: Rpc | Rpc[];
  try {
    body = JSON.parse(text) as Rpc | Rpc[];
  } catch {
    return json(rpcError(null, -32700, "тело — не JSON"), 400);
  }
  const as = req.headers.get("x-sb-as") ?? undefined;
  // пропуск сверяется один раз на запрос HTTP, сколько бы сообщений в нём ни было
  let verified: Promise<void> | null = null;
  const checked = () =>
    (verified ??= within((deps.platform ?? env.PLATFORM).who(key!, as), READ_MS, "платформа не ответила, кто пришёл").then((who) => {
      if ("error" in who) throw new Unauthorized(who.error);
    }));

  /** Одно сообщение JSON-RPC → ответ; уведомление — null. */
  async function answer(m: Rpc): Promise<unknown> {
    if (!m || typeof m !== "object" || typeof m.method !== "string") return rpcError(m?.id, -32600, "нет method");
    if (m.id === undefined) return null;
    switch (m.method) {
      case "initialize": {
        await checked();
        const asked = String(m.params?.protocolVersion ?? KNOWN[0]);
        // кто подключился, видно по пропуску: сессия флота приходит со своим позывным, человек со своим Claude — без него
        const instructions = kindOf(as) === "session" ? RULES : RULES_OUT;
        return { jsonrpc: "2.0", id: m.id, result: { protocolVersion: KNOWN.includes(asked) ? asked : KNOWN[0], capabilities: { tools: { listChanged: false }, resources: {} }, serverInfo: { name: "switchboard", version: "2" }, instructions } };
      }
      case "resources/list":
        await checked();
        return { jsonrpc: "2.0", id: m.id, result: { resources: GUIDES.map((g) => ({ uri: g.uri, name: g.name, mimeType: "text/markdown" })) } };
      case "resources/read": {
        await checked();
        const g = GUIDES.find((x) => x.uri === m.params?.uri);
        if (!g) return rpcError(m.id, -32002, `страницы справки ${String(m.params?.uri)} нет; есть: ${GUIDES.map((x) => x.uri).join(", ")}`);
        return { jsonrpc: "2.0", id: m.id, result: { contents: [{ uri: g.uri, mimeType: "text/markdown", text: g.text }] } };
      }
      case "ping":
        return { jsonrpc: "2.0", id: m.id, result: {} };
      case "tools/list":
        await checked();
        return { jsonrpc: "2.0", id: m.id, result: { tools: tools() } };
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const def = contract.tools().find((d) => toolName(d.name) === name);
        if (!def) return rpcError(m.id, -32602, `инструмента ${name} нет`);
        const args = m.params?.arguments;
        const f: Frame = { ...(args && typeof args === "object" ? (args as Record<string, unknown>) : {}), type: def.name, id: newId("r"), trace: newId("t") };
        const lap = stopwatch();
        const r = await call(env, exec, handlers, deps, f, { key, as, origin });
        if (!r.ok && r.error === "bad_key") throw new Unauthorized(r.why ?? "bad_key");
        const content = r.ok ? toolContent(r.result) : [{ type: "text" as const, text: `${r.error}${r.why ? `: ${r.why}` : ""} (trace ${r.trace})` }];
        // строка журнала на каждый вызов: какой инструмент, кто звал, сколько знаков ушло модели — «не гоняем ли мусор» видно запросом к истории флота
        const chars = content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
        const fleet = parsePass(key)!.fleet;
        const line = { tool: name, from: as ?? "", ms: lap(), ok: r.ok, chars, images: content.length - content.filter((c) => c.type === "text").length, trace: r.trace };
        log.info("инструмент", { module: "mcp", fleet, ...line });
        exec.waitUntil(toolLine(env, deps.fetch ?? outbound, fleet, as ? (machineOf(as) ?? "") : "", line).catch((e: unknown) => log.warn("строка инструмента не записалась", { module: "mcp", fleet, why: e instanceof Error ? e.message : String(e) })));
        return { jsonrpc: "2.0", id: m.id, result: { content, isError: !r.ok } };
      }
      default:
        return rpcError(m.id, -32601, `метода ${m.method} нет`);
    }
  }

  const list = Array.isArray(body) ? body : [body];
  if (!list.length) return json(rpcError(null, -32600, "пустая пачка"), 400);
  try {
    const out = (await Promise.all(list.map(answer))).filter((x) => x !== null);
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(Array.isArray(body) ? out : out[0]);
  } catch (e) {
    if (e instanceof Unauthorized) return unauthorized(origin, e.message);
    throw e;
  }
}
