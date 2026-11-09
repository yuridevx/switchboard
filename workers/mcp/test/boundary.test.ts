// Леса границы «сервер MCP флота»: вход — HTTP MCP (JSON-RPC по POST /mcp), исход — ответ клиенту и запрос владельцу.
// Подделки: gate.verify, releases.tools, владельцы запросов — fetch. Номер — эталон дизайна «Прокси модели»; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTool } from "@switchboard/releases";
import worker, { type Env } from "../src/index.ts";

const LIVE = "pult.k7f2.S";
const TOOLS: McpTool[] = [
  { name: "points_list", description: "Каталог", inputSchema: { type: "object", properties: { q: { type: "string" } } }, request: "points.list", v: 2, url: "https://points.test" },
  { name: "fleetkeys_set", description: "Ключ", inputSchema: { type: "object" }, request: "fleetkeys.set", v: 1, url: "https://fleetkeys.test" },
];
let tools: McpTool[];
let posts: Array<{ url: string; body: Record<string, unknown> }>;
let owner: (body: Record<string, unknown>) => unknown;
const verified: string[] = [];

const env: Env = {
  GATE: { verify: async (key) => (verified.push(key), key === LIVE || key.startsWith("site.") ? { kid: "k7f2", addr: "pult~ann@example.com" } : { error: "bad_key" }) },
  RELEASES: { tools: async () => tools },
  GATE_URL: "https://gate.test",
};

beforeEach(() => {
  tools = [...TOOLS];
  posts = [];
  verified.length = 0;
  owner = () => ({ type: "reply", id: "mcp", ok: true, result: { rows: [1] } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    posts.push({ url: String(url), body });
    return Response.json(owner(body));
  });
});
afterEach(() => vi.restoreAllMocks());

const rpc = (body: unknown, key: string | null = LIVE) =>
  worker.fetch(new Request("https://mcp.test/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) } }), env);
const call = (name: string, args: Record<string, unknown>, key?: string) => rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, key);

describe("вход по пропуску", () => {
  it("initialize и tools/list — пропуск сверяет gate; без пропуска и с неживым — 401 со ссылкой на метаданные ресурса", async () => {
    const ok = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai" } } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "switchboard" } } });
    expect(verified).toEqual([LIVE]);
    for (const key of [null, "pult.k7f2.bad"]) {
      const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, key);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"');
    }
  });

  it("метаданные ресурса: ресурс — /mcp, сервер входа — gate", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await worker.fetch(new Request(`https://mcp.test${path}`), env);
      expect(await r.json()).toEqual({ resource: "https://mcp.test/mcp", authorization_servers: ["https://gate.test"], bearer_methods_supported: ["header"] });
    }
  });

  it("уведомление — 202 без тела; GET — 405; неизвестный метод — ошибка JSON-RPC", async () => {
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await worker.fetch(new Request("https://mcp.test/mcp", { headers: { authorization: `Bearer ${LIVE}` } }), env)).status).toBe(405);
    expect(await (await rpc({ jsonrpc: "2.0", id: 9, method: "resources/list" })).json()).toMatchObject({ id: 9, error: { code: -32601 } });
  });
});

describe("инструменты", () => {
  it("31 · tools/list — список «Выпусков» как есть: новый инструмент нового модуля виден без правки mcp", async () => {
    tools.push({ name: "notes_add", description: "Заметка", inputSchema: { type: "object" }, request: "notes.add", v: 1, url: "https://notes.test" });
    const r = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: Array<{ name: string }> } };
    expect(r.result.tools).toEqual([
      { name: "points_list", description: "Каталог", inputSchema: TOOLS[0].inputSchema },
      { name: "fleetkeys_set", description: "Ключ", inputSchema: { type: "object" } },
      { name: "notes_add", description: "Заметка", inputSchema: { type: "object" } },
    ]);
    await call("notes_add", { text: "x" });
    expect(posts).toEqual([{ url: "https://notes.test", body: { text: "x", type: "notes.add", id: "mcp", v: 1, key: LIVE } }]);
  });

  it("30 · 45 · tools/call — POST владельцу с пропуском клиента, gate mcp не зовёт; ответ владельца — текстом инструмента; отказ — isError словом", async () => {
    const r = (await (await call("points_list", { q: "миграция" })).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(posts).toEqual([{ url: "https://points.test", body: { q: "миграция", type: "points.list", id: "mcp", v: 2, key: LIVE } }]);
    expect(verified).toEqual([]);
    expect(JSON.parse(r.result.content[0].text)).toEqual({ rows: [1] });
    expect(r.result.isError).toBeUndefined();
    owner = () => ({ type: "reply", id: "mcp", ok: false, error: "no_key", why: "ключа orca нет" });
    const no = (await (await call("fleetkeys_set", { name: "orca", env: {} }, "site.k4.S")).json()) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(no.result).toEqual({ content: [{ type: "text", text: "fleetkeys.set: no_key — ключа orca нет" }], isError: true });
    expect(posts.at(-1)!.body.key).toBe("site.k4.S");
  });

  it("владелец ответил bad_key — клиенту 401: пропуск отозван, клиент входит заново", async () => {
    owner = () => ({ type: "reply", id: "mcp", ok: false, error: "bad_key" });
    expect((await call("points_list", {})).status).toBe(401);
  });

  it("инструмента нет — ошибка JSON-RPC, владельца не зовут", async () => {
    expect(await (await call("nope", {})).json()).toMatchObject({ id: 3, error: { code: -32602, message: "инструмента nope нет" } });
    expect(posts).toEqual([]);
  });
});
