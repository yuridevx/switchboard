// Сервер MCP флота: протокол MCP → запросы Worker-модулей, как rooms переводит Telegram в кадры. Модулей не знает: список — releases.tools.
import type { GateApi } from "@switchboard/gate";
import { CALL_MS, READ_MS, within } from "@switchboard/protocol";
import type { McpTool } from "@switchboard/releases";
import { ENDPOINT } from "../contract.ts";

export type Env = { GATE: Pick<GateApi, "verify">; RELEASES: { tools(): Promise<McpTool[]> }; GATE_URL: string };

const VERSION = "2025-06-18";
const KNOWN = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1024 * 1024;
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "www-authenticate, mcp-session-id" };

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const log = (line: string) => console.log(line);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...CORS, ...headers } });
const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Метаданные ресурса (RFC 9728): где входить. */
const resourceMeta = (origin: string, env: Env) => json({ resource: `${origin}${ENDPOINT}`, authorization_servers: [env.GATE_URL], bearer_methods_supported: ["header"] });

/** Неживой пропуск: 401 со ссылкой на метаданные — клиент идёт в OAuth. */
const unauthorized = (origin: string, why: string) => {
  log(`401 · ${why}`);
  return new Response(null, { status: 401, headers: { ...CORS, "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
};

class Unauthorized extends Error {}

async function call(tool: McpTool, args: Record<string, unknown>, key: string) {
  const body = JSON.stringify({ ...args, type: tool.request, id: "mcp", v: tool.v, key });
  const res = await within(fetch(tool.url, { method: "POST", body }), `${tool.request}: владелец молчит`, CALL_MS);
  const reply = (await res.json()) as { ok: boolean; result?: unknown; error?: string; why?: string };
  if (!reply.ok && reply.error === "bad_key") throw new Unauthorized(`${tool.request}: bad_key у владельца`);
  const text = reply.ok ? JSON.stringify(reply.result ?? { ok: true }, null, 2) : `${tool.request}: ${reply.error}${reply.why ? ` — ${reply.why}` : ""}`;
  return { content: [{ type: "text", text }], ...(reply.ok ? {} : { isError: true }) };
}

/** Одно сообщение JSON-RPC → ответ; уведомление — null. */
async function answer(m: Rpc, key: string, env: Env, checked: () => Promise<void>): Promise<unknown> {
  if (m.id === undefined) return null;
  const tools = () => within(env.RELEASES.tools(), "releases не ответил на tools", READ_MS);
  switch (m.method) {
    case "initialize": {
      await checked();
      const asked = String(m.params?.protocolVersion ?? VERSION);
      return { jsonrpc: "2.0", id: m.id, result: { protocolVersion: KNOWN.includes(asked) ? asked : VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "switchboard", version: "1.0.0" } } };
    }
    case "ping":
      return { jsonrpc: "2.0", id: m.id, result: {} };
    case "tools/list": {
      await checked();
      return { jsonrpc: "2.0", id: m.id, result: { tools: (await tools()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
    }
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      const tool = (await tools()).find((t) => t.name === name);
      if (!tool) return rpcError(m.id, -32602, `инструмента ${name} нет`);
      const args = m.params?.arguments;
      return { jsonrpc: "2.0", id: m.id, result: await call(tool, args && typeof args === "object" ? (args as Record<string, unknown>) : {}, key) };
    }
    default:
      return rpcError(m.id, -32601, `метода ${m.method} нет`);
  }
}

async function serve(req: Request, env: Env, origin: string): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...CORS, allow: "POST" } });
  const key = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!key) return unauthorized(origin, "без пропуска");
  const text = await req.text();
  if (text.length > MAX_BODY) return json(rpcError(null, -32600, "тело больше 1 МБ"), 413);
  let body: Rpc | Rpc[];
  try {
    body = JSON.parse(text);
  } catch {
    return json(rpcError(null, -32700, "не JSON"), 400);
  }
  let verified: Promise<void> | null = null;
  const checked = () =>
    (verified ??= within(env.GATE.verify(key), "gate не ответил на verify", READ_MS).then((who) => {
      if ("error" in who) throw new Unauthorized(`${who.error} · ${key.split(".").slice(0, -1).join(".")}`);
    }));
  const list = Array.isArray(body) ? body : [body];
  try {
    const out = (await Promise.all(list.map((m) => answer(m, key, env, checked)))).filter((x) => x !== null);
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(Array.isArray(body) ? out : out[0]);
  } catch (e) {
    if (e instanceof Unauthorized) return unauthorized(origin, e.message);
    log(`failed · ${e}`);
    return json(rpcError(list[0]?.id, -32603, String(e)), 500);
  }
}

export default {
  fetch(req: Request, env: Env): Response | Promise<Response> {
    const { pathname, origin } = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id" } });
    if (pathname.startsWith("/.well-known/oauth-protected-resource")) return resourceMeta(origin, env);
    if (pathname === ENDPOINT) return serve(req, env, origin);
    return new Response("switchboard mcp: POST /mcp\n", { status: 404, headers: CORS });
  },
};
