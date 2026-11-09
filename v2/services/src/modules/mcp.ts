// Сервер MCP флота: один для сессий флота и внешнего Claude. Инструмент — запрос договора с описанием для модели;
// вызов идёт тем же входом, что POST /call. Своих инструментов и состояния нет.
import { contract, type Frame, newId, parsePass, type RequestDef, z } from "@sb/protocol";
import type { Deps, Env } from "../env.ts";
import { bearer, call, type handlersOf } from "../entrance.ts";

const VERSION = "2025-06-18";

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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const result = (id: Rpc["id"], r: unknown) => json({ jsonrpc: "2.0", id, result: r });
const error = (id: Rpc["id"], code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

export async function mcp(req: Request, env: Env, exec: ExecutionContext, handlers: ReturnType<typeof handlersOf>, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const key = bearer(req);
  if (!parsePass(key)) return error(null, -32001, "нужен пропуск флота: Authorization: Bearer", 401);
  let m: Rpc;
  try {
    m = (await req.json()) as Rpc;
  } catch {
    return error(null, -32700, "тело — не JSON", 400);
  }
  if (!m || typeof m.method !== "string") return error(m?.id, -32600, "нет method", 400);
  // уведомления ответа не ждут
  if (m.id === undefined) return new Response(null, { status: 202 });
  const as = req.headers.get("x-sb-as") ?? undefined;
  switch (m.method) {
    case "initialize": {
      const who = await (deps.platform ?? env.PLATFORM).who(key!, as);
      if ("error" in who) return error(m.id, -32001, `пропуск не принят: ${who.error}`, 401);
      return result(m.id, { protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : VERSION, capabilities: { tools: {} }, serverInfo: { name: "switchboard", version: "2" } });
    }
    case "ping":
      return result(m.id, {});
    case "tools/list":
      return result(m.id, { tools: tools() });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      const def = contract.tools().find((d) => toolName(d.name) === name);
      if (!def) return error(m.id, -32602, `инструмента ${name} нет`);
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      const f: Frame = { ...args, type: def.name, id: newId("r"), trace: newId("t") };
      const r = await call(env, exec, handlers, deps, f, { key, as, origin: new URL(req.url).origin });
      if (r.ok) return result(m.id, { content: [{ type: "text", text: JSON.stringify(r.result ?? {}) }], isError: false });
      return result(m.id, { content: [{ type: "text", text: `${r.error}${r.why ? `: ${r.why}` : ""} (trace ${r.trace})` }], isError: true });
    }
    default:
      return error(m.id, -32601, `метода ${m.method} нет`);
  }
}
