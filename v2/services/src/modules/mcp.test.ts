import { describe, expect, it } from "vitest";
import { type Stand, stand } from "../../test/stand.ts";

type Rpc = { result?: any; error?: { code: number; message: string } };

async function rpc(s: Stand, method: string, params: unknown, as: string | null = "kanya1", extra: Record<string, string> = {}, id: number | null = 1) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (as) headers.authorization = "Bearer " + s.key(as);
  const res = await s.http("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }) });
  return { status: res.status, headers: res.headers, body: (res.headers.get("content-type")?.includes("json") ? await res.json() : {}) as Rpc };
}

describe("сервер MCP", () => {
  it("без пропуска и с чужим пропуском — 401; с пропуском — initialize отвечает версией клиента", async () => {
    const s = stand();
    expect((await rpc(s, "initialize", {}, null)).status).toBe(401);
    expect((await rpc(s, "initialize", {}, "knobody")).status).toBe(401);
    const ok = await rpc(s, "initialize", { protocolVersion: "2025-03-26" });
    expect(ok.body.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "switchboard" } });
    expect((await rpc(s, "notifications/initialized", {}, "kanya1", {}, null)).status).toBe(202);
  });

  it("инструменты — запросы договора с описанием для модели: имя через _, схема ввода из договора", async () => {
    const s = stand();
    const tools = (await rpc(s, "tools/list", {})).body.result.tools as { name: string; description: string; inputSchema: any }[];
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["session_open", "message", "points_list", "builds_deploy", "prefs_get"]));
    expect(names.some((n) => n.includes("."))).toBe(false);
    expect(names).not.toContain("keys_value");
    const open = tools.find((t) => t.name === "session_open")!;
    expect(open.description).toContain("Открыть");
    expect(open.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["to", "spec"]) });
    expect(open.inputSchema.properties.spec.required).toEqual(expect.arrayContaining(["name", "cwd"]));
  });

  it("вызов инструмента идёт тем же входом: ответ службы, права и отказ словом", async () => {
    const s = stand();
    await rpc(s, "tools/call", { name: "prefs_set", arguments: { scope: "me", name: "view", value: "плотный" } });
    const got = await rpc(s, "tools/call", { name: "prefs_get", arguments: { scope: "me" } });
    expect(got.body.result.isError).toBe(false);
    expect(JSON.parse(got.body.result.content[0].text)).toEqual({ values: { view: "плотный" } });
    const refused = await rpc(s, "tools/call", { name: "message", arguments: { to: "site@oleg-mac", text: "привет" } });
    expect(refused.body.result.isError).toBe(true);
    expect(refused.body.result.content[0].text).toContain("forbidden");
    expect((await rpc(s, "tools/call", { name: "no_such", arguments: {} })).body.error?.code).toBe(-32602);
  });

  it("сессия флота зовёт инструмент пропуском машины и своим позывным: отправитель — сессия", async () => {
    const s = stand();
    const r = await rpc(s, "tools/call", { name: "message", arguments: { to: "docs@server", text: "обнови раздел" } }, "klaptop", { "x-sb-as": "site@laptop" });
    expect(r.body.result.isError).toBe(false);
    expect(s.seen.delivered).toMatchObject([{ type: "message", to: "docs@server", from: "site@laptop", text: "обнови раздел" }]);
  });
});
