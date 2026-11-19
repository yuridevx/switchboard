// Опыт: режим памяти «только чтение» штатными средствами Claude Code. Три прогона на Haiku в режиме «разрешено всё»:
// A — память включена, запись разрешена; B — автопамять выключена, индекс добавкой, замок на запись; C — память включена, замок на запись.
// node exp-memory.mjs <корень репо с node_modules>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { query } = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href);

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE" && !/^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|SESSION|AGENT)/.test(k)));
Object.assign(env, { DISABLE_UPDATES: "1", CLAUDE_CODE_HARBOR_KITE: "0" });
const TASK = "Запомни на будущее: тесты этого проекта запускаются командой `npm run box`. Сохрани это в память и ответь одним предложением, что сделал.";

async function run(name, { memory, lock, append }) {
  const dir = fs.mkdtempSync(path.join(here, `exp-${name}-`));
  const mem = path.join(dir, "memory");
  fs.mkdirSync(mem);
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- [Стиль](style.md) — отступ два пробела\n");
  fs.writeFileSync(path.join(mem, "style.md"), "---\nname: style\ndescription: отступ два пробела\nmetadata:\n  type: project\n---\nОтступ — два пробела.\n");
  const before = fs.readdirSync(mem).length;
  let tried = 0, refused = 0, size = 0, answer = "";
  const guard = async (input) => {
    const file = path.resolve(String(input.tool_input?.file_path ?? ""));
    if (!file.startsWith(mem + path.sep)) return {};
    tried++;
    if (!lock) return {};
    refused++;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Память только для чтения: эта модель не из пишущих память." } };
  };
  const options = {
    cwd: dir, env, model: "claude-haiku-5-5", maxTurns: 8, settingSources: [],
    permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    settings: memory ? { autoMemoryDirectory: mem } : { autoMemoryEnabled: false },
    systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append: append(mem) } : {}) },
    hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [guard] }] },
  };
  for await (const m of query({ prompt: TASK, options })) {
    if (m.type === "assistant" && !size) { const u = m.message.usage ?? {}; size = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0); }
    if (m.type === "result") answer = String(m.result ?? m.subtype).replace(/\s+/g, " ").slice(0, 220);
  }
  const files = fs.readdirSync(mem);
  const index = fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8").split("\n").filter(Boolean).length;
  console.log(JSON.stringify({ run: name, firstRequestTokens: size, writesTried: tried, refused, newFiles: files.length - before, indexLines: index, answer }));
}

const readOnly = (mem) => `Память проекта лежит в ${mem}. Читай её файлы по этому пути. Писать в неё на этой модели нельзя.\nЕё индекс:\n${fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8")}`;
const only = process.argv[3];
for (const [name, o] of [["A", { memory: true, lock: false }], ["B", { memory: false, lock: true, append: readOnly }], ["C", { memory: true, lock: true }]]) if (!only || only === name) await run(name, o);
