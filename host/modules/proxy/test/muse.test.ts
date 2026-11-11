// Перевод Muse: записанный поток Meta (Muse CLI, 29 окт.) → поток Anthropic; эталон — то, что из того же потока сделал museclaude.
// Запрос и вызов через поддельный Meta на localhost: перевод, ошибки и лимиты. Номер эталона — номер теста; без номера — чьё: код.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { messages } from "../src/muse/handle.ts";
import { toMetaRequest } from "../src/muse/request.ts";
import { MessageReducer, StreamTranslator } from "../src/muse/stream.ts";

const sse = readFileSync(new URL("./fixtures/meta-reasoning-text-tool.sse", import.meta.url), "utf8");
const expected = JSON.parse(readFileSync(new URL("./fixtures/meta-reasoning-text-tool.anthropic.json", import.meta.url), "utf8"));
const events = sse
  .split("\n\n")
  .map((f) => f.split("\n").find((l) => l.startsWith("data: "))?.slice(6))
  .filter((d): d is string => !!d && d !== "[DONE]")
  .map((d) => JSON.parse(d));
const ctx = { requestedModel: "claude-opus-5-5", metaModel: "muse-wonder-1.0", effort: "high", webSearch: null, droppedTools: [], sessionId: null };
const run = (o: { showThinking: boolean; stopSequences?: string[] }) => {
  const tr = new StreamTranslator({ ...ctx, stopSequences: [], ...o });
  return [...events.flatMap((e) => tr.handle(e)), ...tr.finish()];
};

describe("перевод Muse", () => {
  it("19 · записанный поток Meta: события Anthropic совпадают с museclaude — с рассуждением, без него и со стоп-строкой", () => {
    expect(run({ showThinking: true })).toEqual(expected.shown);
    expect(run({ showThinking: false })).toEqual(expected.hidden);
    expect(run({ showThinking: true, stopSequences: ["decision for"] })).toEqual(expected.stop);
    const r = new MessageReducer();
    r.push({ type: "message_start", message: { id: "m", content: [], usage: {} } });
    for (const e of expected.shown) r.push(e);
    expect(r.message!.content.map((b: { type: string }) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(r.message!.stop_reason).toBe("tool_use");
  });

  it("запрос: system без строки учёта, модель как назвал claude, рассуждение из подписи назад в reasoning, tool_result — function_call_output", () => {
    const sig = `meta1.${Buffer.from(JSON.stringify({ i: "rs_1", e: "enc" })).toString("base64url")}`;
    const { body } = toMetaRequest({
      model: "muse-wonder-1.0",
      max_tokens: 4000,
      system: [{ type: "text", text: "x-anthropic-billing-header: cc" }, { type: "text", text: "Ты агент." }],
      metadata: { user_id: JSON.stringify({ session_id: "s-1" }) },
      tools: [{ name: "Bash", input_schema: { $schema: "x", type: "object", properties: {} } }, { type: "bash_20250124", name: "bash" }],
      messages: [
        { role: "user", content: "привет" },
        { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: sig }, { type: "tool_use", id: "t1", name: "Bash", input: { c: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    expect(body.model).toBe("muse-wonder-1.0");
    expect(body.instructions).toBe("Ты агент.");
    expect(body.prompt_cache_key).toBe("ccp:s-1");
    expect(body.tools).toEqual([{ type: "function", name: "Bash", description: "", parameters: { type: "object", properties: {} }, strict: false }]);
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "привет" }] },
      { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] },
      { type: "function_call", call_id: "t1", name: "Bash", arguments: '{"c":1}' },
      { type: "function_call_output", call_id: "t1", output: "ok" },
    ]);
  });

  it("вызов: заголовки Muse CLI и ключ из маршрута, поток Anthropic; 429 квоты — заголовки лимита Anthropic", async () => {
    let got: IncomingMessage | null = null;
    let mode = "ok";
    const server: Server = createServer((q, r) => {
      got = q;
      q.resume();
      q.on("end", () => {
        if (mode === "quota") return r.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "rate_limit_exceeded", resets_at: 1793280000, message: "weekly limit" } }));
        r.writeHead(200, { "content-type": "text/event-stream" });
        r.end(sse);
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const proxy: Server = createServer((q, r) => {
      let b = "";
      q.on("data", (d) => (b += d));
      q.on("end", () => void messages(r, JSON.parse(b), { key: "meta-key", base, version: "1.4.14" }, new AbortController().signal, () => {}));
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const anth = { model: "muse-wonder-1.0", stream: true, thinking: { type: "enabled", budget_tokens: 8000 }, messages: [{ role: "user", content: "hi" }], metadata: { user_id: JSON.stringify({ session_id: "0198f2a4-0000-7000-8000-000000000001" }) } };
    const text = await (await fetch(url, { method: "POST", body: JSON.stringify(anth) })).text();
    expect(text).toContain('"type":"message_start"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(got!.headers.authorization).toBe("Bearer meta-key");
    expect(got!.headers["user-agent"]).toMatch(/^muse-build\/1\.4\.14 \(non-interactive; /);
    expect(got!.headers["x-tbh-session-id"]).toBe("0198f2a4-0000-7000-8000-000000000001");
    mode = "quota";
    const q = await fetch(url, { method: "POST", body: JSON.stringify(anth) });
    expect(q.status).toBe(429);
    expect(q.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("seven_day");
    expect(q.headers.get("anthropic-ratelimit-unified-reset")).toBe("1793280000");
    server.close();
    proxy.close();
  });
});
