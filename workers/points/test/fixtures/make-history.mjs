// Разговор для эталонов 28, 38, 39 и ответ SDK с диска — так, как его читает session.history живой сессии.
// node workers/points/test/fixtures/make-history.mjs — пишет history.jsonl и history.expected.json рядом.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SID = "9f1c0000-0000-4000-8000-000000000001";
const CWD = "/home/ann/site";
let t = Date.parse("2030-10-31T20:00:00.000Z");
const at = () => new Date((t += 1000)).toISOString();
const base = { sessionId: SID, cwd: CWD, version: "2.1.311", userType: "external", isSidechain: false };
let parent = null;
const rec = (x) => {
  const r = { ...base, parentUuid: parent, timestamp: at(), ...x };
  if (x.uuid) parent = x.uuid;
  return r;
};
const usage = (i, o) => ({ input_tokens: i, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: o });
const SYSTEM = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: "text", text: "# Environment\nWorking directory: /home/ann/site" }];
const request = (id, model) => ({ type: "api-request", sessionId: SID, id, timestamp: at(), version: "2.1.311", querySource: "sdk", shapeHash: "s1", params: { model, max_tokens: 32000 }, keep: 0, tail: [] });

const lines = [
  { type: "api-request-shape", sessionId: SID, shapeHash: "s1", timestamp: at(), version: "2.1.311", shape: { system: SYSTEM, tools: [{ name: "Bash" }] } },
  request("r1", "claude-opus-5-5"),
  rec({ type: "user", uuid: "u1", message: { role: "user", content: "перенеси журнал в ClickHouse" } }),
  rec({ type: "assistant", uuid: "a1", requestRef: "r1", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Смотрю схему журнала." }], usage: usage(10, 20) } }),
  rec({ type: "assistant", uuid: "a1b", requestRef: "r1", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }], usage: usage(10, 20) } }),
  request("r2", "claude-opus-5-5"),
  rec({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "journal.ts" }] }, toolUseResult: "journal.ts" }),
  rec({ type: "assistant", uuid: "a2", requestRef: "r2", message: { id: "m2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Журнал — один файл." }], usage: usage(30, 40) } }),
  { type: "ai-title", sessionId: SID, aiTitle: "Перенеси журнал в ClickHouse" },
  rec({ type: "system", uuid: "s1", subtype: "informational", content: "Сессия продолжена", level: "info" }),
  request("r3", "claude-sonnet-5-5"),
  rec({ type: "user", uuid: "u3", message: { role: "user", content: "а миграция d1?" } }),
  rec({ type: "assistant", uuid: "a3", requestRef: "r3", message: { id: "m3", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Миграция D1 не нужна." }], usage: usage(50, 60) } }),
];
const text = `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`;
writeFileSync(join(here, "history.jsonl"), text);

// SDK читает с диска, как session.history: своя папка Claude, папка проекта по рабочей папке
const home = mkdtempSync(join(tmpdir(), "sb-history-"));
process.env.CLAUDE_CONFIG_DIR = home;
const project = join(home, "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(project, { recursive: true });
writeFileSync(join(project, `${SID}.jsonl`), text);
const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
const messages = await getSessionMessages(SID, { dir: CWD, includeSystemMessages: true });
rmSync(home, { recursive: true, force: true });
writeFileSync(join(here, "history.expected.json"), `${JSON.stringify({ sid: SID, messages }, null, 1)}\n`);
console.log(`строк ${lines.length}, сообщений ${messages.length}: ${messages.map((m) => m.uuid).join(" ")}`);
