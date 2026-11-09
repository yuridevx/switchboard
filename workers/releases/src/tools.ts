// Список инструментов MCP флота: запросы с tool в манифестах Worker-модулей каталога и адреса их владельцев.
// Сервер mcp модулей не знает: выложили модуль с новым инструментом — список новый, код mcp не тронут.
import type { McpTool } from "../contract.ts";
import type { Catalog } from "./catalog.ts";
import { addressing } from "./cloud.ts";
import type { Env } from "./env.ts";

export async function toolsOf(env: Env, cat: Catalog): Promise<McpTool[]> {
  const parts = (await cat.all()).filter((p) => p.kind === "cloud" && p.manifest?.tools);
  const address = await addressing(env);
  return parts.flatMap((p) =>
    Object.entries(p.manifest!.tools!).map(([request, t]) => ({
      name: request.replaceAll(".", "_"),
      description: t.about,
      inputSchema: t.input ?? { type: "object" },
      request,
      v: p.manifest!.provides[request],
      url: address(p.script!),
    })),
  );
}
