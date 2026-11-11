// Сервер MCP флота: один для сессий флота и внешнего Claude. Инструмент — запрос договора с описанием для модели;
// вызов идёт тем же входом, что POST /call. Своих инструментов и состояния нет.
// Вход — Bearer пропуска (у сессии флота — пропуск машины и позывной в x-sb-as); без живого пропуска — 401 со ссылкой на метаданные входа OAuth.
import { contract, type Frame, newId, parsePass, READ_MS, type RequestDef, within, z } from "@sb/protocol";
import type { Deps, Env } from "../../env.ts";
import { bearer, call, type handlersOf } from "../../entrance.ts";
import { log } from "../../env.ts";

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

/** Инструменты из договора. */
export const tools = () => contract.tools().map((d) => ({ name: toolName(d.name), description: d.tool!, inputSchema: schemaOf(d) }));

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const IMAGES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Ответ инструмента для модели: текст — результат запроса; картинки среди файлов результата (скрипт положил их в $SB_OUT) идут блоками изображения, а не строкой base64. */
export function toolContent(result: unknown): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
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
        return { jsonrpc: "2.0", id: m.id, result: { protocolVersion: KNOWN.includes(asked) ? asked : KNOWN[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "switchboard", version: "2" } } };
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
        const r = await call(env, exec, handlers, deps, f, { key, as, origin });
        if (!r.ok && r.error === "bad_key") throw new Unauthorized(r.why ?? "bad_key");
        if (r.ok) return { jsonrpc: "2.0", id: m.id, result: { content: toolContent(r.result), isError: false } };
        return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${r.error}${r.why ? `: ${r.why}` : ""} (trace ${r.trace})` }], isError: true } };
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
