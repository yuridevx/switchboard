// Эталоны дизайна «Связь сессий и знание о флоте»: что сервер инструментов отдаёт модели.
import { contract, z } from "@sb/protocol";
import { describe, expect, it } from "vitest";
import { type Stand, stand } from "../../test/stand.ts";
import { GUIDES, RULES, RULES_OUT } from "./mcp/guide.ts";
import { lean, toolContent, toolName } from "./mcp/mcp.ts";

type Rpc = { result?: any; error?: { code: number; message: string } };
async function rpc(s: Stand, method: string, params: unknown, as = "kanya1", extra: Record<string, string> = {}) {
  const res = await s.http("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.key(as), ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await res.json()) as Rpc;
}
const SESSION = { "x-sb-as": "site@laptop" };

/** Имена вида a_b в тексте: инструменты и поля их ввода. */
const names = (text: string) => [...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
const known = () => {
  const all = new Set(contract.tools().map((d) => toolName(d.name)));
  const fields = (schema: any): void => {
    for (const [k, v] of Object.entries(schema?.properties ?? {})) {
      all.add(k);
      fields(v);
    }
  };
  for (const d of contract.tools()) fields(z.toJSONSchema(d.input, { unrepresentable: "any" }));
  // слова отказов: их называют описания инструментов — справка новых не вводит
  for (const d of contract.tools()) for (const n of names(d.tool!)) all.add(n);
  return all;
};

describe("знание о флоте", () => {
  // чьё: слово пользователя 15 нояб. — «все доки MCP с примерами»
  it("каждый инструмент: описание с примером вызова; читающим — пометка «только чтение», меняющим её нет", async () => {
    const tools = (await rpc(stand(), "tools/list", {})).result.tools as { name: string; description: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.length).toBe(contract.tools().length);
    for (const t of tools) expect(t.description, t.name).toMatch(/\nПример: \{/);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.fleet_list!.annotations).toEqual({ readOnlyHint: true });
    expect(by.session_history!.annotations).toEqual({ readOnlyHint: true });
    expect(by.message!.annotations).toBeUndefined();
    expect(by.session_remove!.annotations).toBeUndefined();
    expect(JSON.parse(by.message!.description.split("\nПример: ")[1]!)).toEqual({ to: "coder@server", text: "Собери срез 2 и пришли номер коммита" });
  });

  // чьё: факт опыта — Claude Code показывает инструкции сервера; предел 4 096 знаков
  it("подключение сессии флота: инструкции не длиннее 4 096 знаков, каждый названный в них инструмент есть в договоре", async () => {
    const got = (await rpc(stand(), "initialize", {}, "klaptop", SESSION)).result;
    expect(got.instructions).toBe(RULES);
    expect(got.capabilities).toMatchObject({ tools: {}, resources: {} });
    expect(RULES.length).toBeLessThanOrEqual(4096);
    const all = known();
    expect(names(RULES).length).toBeGreaterThan(5);
    for (const n of names(RULES)) expect(all.has(n), `в инструкциях назван ${n} — такого инструмента и поля нет`).toBe(true);
    for (const kind of ["task", "message", "result", "question", "news", "incident"]) expect(RULES).toContain(`- ${kind}`);
    // файл и сайт человеку — инструментами: правила называют оба
    for (const tool of ["file_send", "site_publish"]) expect(names(RULES)).toContain(tool);
  });

  // чьё: код — сервер один для сессий флота и внешнего Claude
  it("подключился внешний Claude по пропуску человека — инструкции без позывного, родителя и входящего", async () => {
    const got = (await rpc(stand(), "initialize", {})).result;
    expect(got.instructions).toBe(RULES_OUT);
    for (const word of ["позывной ты знаешь", "родител", "<fleet", "дочь"]) expect(RULES_OUT).not.toContain(word);
    const all = known();
    for (const n of names(RULES_OUT)) expect(all.has(n), n).toBe(true);
  });

  // чьё: слово пользователя 15 нояб. — «MCP API с докой, архитектурой и best practice»
  it("справка: страниц три — практики, архитектура и память; каждый названный инструмент есть в договоре; незнакомая страница — отказ со списком", async () => {
    const s = stand();
    const list = (await rpc(s, "resources/list", {}, "klaptop", SESSION)).result.resources as { uri: string; name: string }[];
    expect(list.map((r) => r.uri)).toEqual(["fleet://guide/practices", "fleet://guide/architecture", "fleet://guide/memory"]);
    const page = (await rpc(s, "resources/read", { uri: "fleet://guide/practices" }, "klaptop", SESSION)).result.contents[0];
    expect(page).toMatchObject({ uri: "fleet://guide/practices", mimeType: "text/markdown", text: GUIDES[0]!.text });
    expect((await rpc(s, "resources/read", { uri: "fleet://guide/tools" }, "klaptop", SESSION)).error?.message).toContain("fleet://guide/architecture");
    const all = known();
    for (const g of GUIDES) for (const n of names(g.text)) expect(all.has(n), `${g.uri}: ${n}`).toBe(true);
  });

  // чьё: слово пользователя 19 нояб. — память пишут сильные модели; список моделей один, у машины: справка называет правило без имён.
  // Правил записи в справке нет: их даёт сам Claude Code (дизайн «Память флота»)
  it("страница «Память»: три слоя, пути к сырью и правило «пишут сильные модели» без имён моделей; инструкции ведут на неё одной строкой", async () => {
    const page = (await rpc(stand(), "resources/read", { uri: "fleet://guide/memory" }, "klaptop", SESSION)).result.contents[0].text as string;
    for (const word of ["Ядро", "Записи", "Сырьё", "session_history", "machine_conversations", "points_list", "сильные модели", "не состояние работы"]) expect(page, word).toContain(word);
    expect(page).not.toMatch(/claude-|opus|fable|sonnet|haiku/i);
    expect(RULES.split("\n").filter((l) => l.includes("fleet://guide/memory"))).toHaveLength(1);
    expect(RULES.length).toBeLessThanOrEqual(4096);
  });
});

describe("ответ инструмента — только нужное модели", () => {
  const SIG = "Eq" + "A1b2C3d4".repeat(60);
  const history = {
    events: [
      { type: "user", uuid: "u1", timestamp: "2026-11-15T20:27:54Z", session_id: "s-1", parent_tool_use_id: null, message: { role: "user", content: "проверь трафик" } },
      { type: "assistant", uuid: "a1", session_id: "s-1", parent_tool_use_id: null, parent_agent_id: null, message: { id: "msg_1", role: "assistant", stop_reason: "tool_use", stop_sequence: null, stop_details: null,
        usage: { input_tokens: 3, cache_read_input_tokens: 184_220, output_tokens: 412 }, context_management: null,
        content: [{ type: "thinking", thinking: "", signature: SIG }, { type: "text", text: "Смотрю пакеты." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "tshark -r dump.pcap" }, caller: { type: "direct" } }] } },
      { type: "user", uuid: "u2", session_id: "s-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "88 пакетов" }] } },
      { type: "result", uuid: "r1", subtype: "success", duration_ms: 4200, num_turns: 2, total_cost_usd: 0.04, usage: { input_tokens: 3 }, modelUsage: { "claude-opus-5-5": { inputTokens: 3 } }, session_id: "s-1" },
    ],
    more: false, seq: 4,
  };

  // чьё: слово пользователя 15 нояб. — «не возвращать поля бесполезные типа шифрованных»
  it("история разговора: подписей, счётчиков и пустых блоков модели нет; текст, вызовы инструментов, их ответы и номер события на месте", () => {
    expect(lean(history)).toEqual({
      events: [
        { type: "user", uuid: "u1", timestamp: "2026-11-15T20:27:54Z", message: { role: "user", content: "проверь трафик" } },
        { type: "assistant", uuid: "a1", message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Смотрю пакеты." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "tshark -r dump.pcap" } }] } },
        { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "88 пакетов" }] } },
        { type: "result", uuid: "r1", subtype: "success", duration_ms: 4200, num_turns: 2, total_cost_usd: 0.04 },
      ],
      more: false, seq: 4,
    });
    const text = (toolContent(history)[0] as { text: string }).text;
    expect(text).not.toContain(SIG);
    expect(text.length).toBeLessThan(JSON.stringify(history).length / 2);
  });

  // чьё: код — пустое вне событий разговора несёт смысл: «сессий нет», «сборка не назначена»
  it("ответ не о разговоре не меняется: пустой список и null остаются", () => {
    const list = { machines: [], sessions: [], stable: null, title: "" };
    expect(lean(list)).toEqual(list);
    expect(toolContent({ ok: 1 })).toEqual([{ type: "text", text: '{"ok":1}' }]);
  });

  // чьё: код — картинка идёт модели блоком изображения; файл, который вернул скрипт, — его содержимое
  it("команда вернула картинку и текстовый файл: картинка — блоком изображения, содержимое файла не вырезано", () => {
    const file = "aGVsbG8g".repeat(40);
    const c = toolContent({ run: "r1", state: "done", files: [{ name: "plot.png", size: 4, base64: "AAAA" }, { name: "log.txt", size: 240, base64: file }] });
    expect(c[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(JSON.parse((c[0] as { text: string }).text).files).toEqual([{ name: "plot.png", size: 4, shown: true }, { name: "log.txt", size: 240, base64: file }]);
  });

  // чьё: слово пользователя 15 нояб. — «убедиться, что мы не гоняем мусор»
  it("любой вызов инструмента — строка журнала в истории флота: инструмент, кто звал, знаков ответа", async () => {
    const s = stand(undefined, { env: { CH_URL: "https://ch.test:8443/", CH_USER: "sb", CH_PASSWORD: "pw" } });
    const rows: Record<string, any>[] = [];
    s.state.net = (url, init) => {
      const q = new URL(url).searchParams.get("query") ?? "";
      if (q.startsWith("INSERT INTO sb2_log")) rows.push(JSON.parse(String(init?.body)));
      return new Response("");
    };
    await rpc(s, "tools/call", { name: "prefs_set", arguments: { scope: "me", name: "view", value: "плотный" } }, "klaptop", SESSION);
    const got = await rpc(s, "tools/call", { name: "prefs_get", arguments: { scope: "me" } }, "klaptop", SESSION);
    const sent = (got.result.content[0].text as string).length;
    const line = rows.find((r) => JSON.parse(r.data).tool === "prefs_get");
    expect(line).toMatchObject({ fleet: s.fleet, machine: "laptop", part: "services", msg: "tool", session: "site@laptop", level: "info" });
    expect(JSON.parse(line!.data)).toMatchObject({ tool: "prefs_get", ok: true, chars: sent });
    expect(rows).toHaveLength(2);
  });
});
