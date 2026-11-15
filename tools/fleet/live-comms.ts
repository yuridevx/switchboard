// Живая проверка связи сессий и знания о флоте: node tools/fleet/live-comms.ts [флот] [устройство] [машина]
// Без модели: короткая картина флота, отказ на выдуманный проект, сервер инструментов (инструкции, примеры, справка, чистка ответа, строка журнала).
// С моделью (ключ и модель — SB2_KEY и SB2_MODEL): родитель даёт задачу дочери — итог видом result; дочь с фоновой командой отвечает дважды;
// подмена Host посреди хода — итог дошёл, задача не пришла дважды; справка прочитана; правила пережили сжатие.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallError, createApi, fleetList, hostRestart, httpTransport, keysModels, logQuery, message, peopleList, sessionCall, sessionHistory, sessionOpen, sessionRemove, type Peer, type SessionRow } from "@sb/protocol";
import { fleetEnv } from "../dev.mjs";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const [fleet = "test", device = "cli", machine = "devbox"] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const wire = httpTransport({ base: env.SB2_BASE!, key });
const api = createApi({ ...wire, call: async (f) => { for (let i = 0; ; i++) { const r = await wire.call(f); if (r.ok || r.error !== "offline" || i >= 4) return r; await new Promise((x) => setTimeout(x, 3000)); } } });
const SEAT = process.env.SB2_KEY ?? "muse";
const DOC = { key: SEAT, model: process.env.SB2_MODEL ?? (await api.call(keysModels, { name: SEAT })).models[0]!.id };
const tag = Date.now().toString(36).slice(-4);
const cwd = machine === "wsl" ? `/tmp/sb2-comms-${tag}` : `C:/Users/${os.userInfo().username}/AppData/Local/Temp/sb2-comms-${tag}`;

let bad = 0, total = 0;
const made: string[] = [];
async function step(label: string, fn: () => Promise<string>) {
  total++;
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${e instanceof CallError ? `${e.word}: ${e.why ?? ""}` : (e as Error).message.split("\n")[0]}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowOf = async (cs: string): Promise<SessionRow | undefined> => ((await api.call(fleetList, { machine, full: true })).sessions as SessionRow[]).find((s) => s.callsign === cs);
async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await sleep(2000);
  }
}
const idle = (cs: string) => until(`${cs} свободна`, async () => (await rowOf(cs))?.state === "idle", 300_000);
async function turn(cs: string, text: string): Promise<void> {
  await api.call(message, { to: cs, text });
  await until(`${cs} взяла ход`, async () => ["busy", "waiting"].includes((await rowOf(cs))?.state ?? ""), 30_000).catch(() => {});
  await idle(cs);
}
type Ev = { type: string; uuid?: string; peer?: Peer; message?: { content?: unknown } };
const said = async (cs: string) => (await api.call(sessionHistory, { to: cs, limit: 200 })).events as Ev[];
/** Входящие от флота у сессии: разобранные отправитель, вид и текст. */
const incoming = async (cs: string, from: string, kind: Peer["kind"]) => (await said(cs)).filter((e) => e.peer?.from === from && e.peer.kind === kind).map((e) => e.peer!.text);
const lastAnswer = async (cs: string) => {
  const texts = (await said(cs)).filter((e) => e.type === "assistant").flatMap((e) => (Array.isArray(e.message?.content) ? (e.message!.content as Array<{ type?: string; text?: string }>) : []).filter((b) => b.type === "text").map((b) => b.text ?? ""));
  return texts.at(-1) ?? "";
};

/** Вызов сервера инструментов тем же пропуском, что у человека со своим Claude. */
async function mcp(method: string, params: unknown = {}): Promise<any> {
  const res = await fetch(env.SB2_BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// ───────── без модели ─────────

await step("картина флота: короткая строка сессии; полная — по full", async () => {
  const brief = await api.call(fleetList, {});
  const full = await api.call(fleetList, { full: true });
  if (brief.sessions.some((s) => "spec" in s || "result" in s)) throw new Error("в короткой строке документ или последний ответ");
  if (full.sessions.length && !full.sessions.every((s) => "spec" in s)) throw new Error("в полной строке нет документа");
  return `сессий ${brief.sessions.length}, знаков: короткая ${JSON.stringify(brief).length}, полная ${JSON.stringify(full).length}`;
});

await step("выдуманный проект отвергнут: отказ no_project со списком «номер — имя»", async () => {
  const projects = (await api.call(peopleList, {})).projects;
  const r = await api.call(sessionOpen, { to: "@" + machine, spec: { name: "np-" + tag, cwd, ...DOC, project: "vydumannyj-proekt" } as never, mkdir: true }).then(() => "открылась", (e: unknown) => (e as CallError));
  if (typeof r === "string") { made.push(`np-${tag}@${machine}`); throw new Error("сессия с выдуманным проектом открылась"); }
  if (r.word !== "no_project") throw new Error(`отказ ${r.word}: ${r.why}`);
  for (const p of projects) if (!String(r.why).includes(`${p.id} — ${p.name}`)) throw new Error(`в отказе нет «${p.id} — ${p.name}»`);
  return `проектов во флоте ${projects.length}; отказ: ${String(r.why).slice(0, 90)}`;
});

await step("сервер инструментов: инструкции, пример у каждого инструмента, пометка «только чтение», две страницы справки", async () => {
  const init = await mcp("initialize", { protocolVersion: "2025-06-18" });
  if (!String(init.instructions).includes("fleet_list") || String(init.instructions).length > 4096) throw new Error("инструкций нет или они длиннее 4 096");
  const tools = (await mcp("tools/list")).tools as Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean } }>;
  const without = tools.filter((t) => !/\nПример: \{/.test(t.description)).map((t) => t.name);
  if (without.length) throw new Error("без примера: " + without.join(", "));
  const long = tools.filter((t) => t.description.length > 4096).map((t) => t.name);
  if (long.length) throw new Error("описание длиннее 4 096: " + long.join(", "));
  if (!tools.find((t) => t.name === "fleet_list")?.annotations?.readOnlyHint || tools.find((t) => t.name === "message")?.annotations) throw new Error("пометка «только чтение» стоит не там");
  const pages = (await mcp("resources/list")).resources as Array<{ uri: string }>;
  const page = (await mcp("resources/read", { uri: "fleet://guide/practices" })).contents[0].text as string;
  if (pages.length !== 2 || !page.includes("session_remove")) throw new Error("справка не та");
  return `инструментов ${tools.length}, знаков описаний ${tools.reduce((n, t) => n + t.description.length, 0)}, инструкций ${String(init.instructions).length}, страниц справки ${pages.length}`;
});

// ───────── с моделью ─────────

let parent = "", child = "";
await step("родитель даёт задачу дочери — итог её хода приходит родителю видом result", async () => {
  parent = (await api.call(sessionOpen, { to: "@" + machine, spec: { name: "cm-lead-" + tag, cwd, ...DOC } as never, mkdir: true })).callsign;
  made.push(parent);
  child = (await api.call(sessionOpen, { to: "@" + machine, spec: { name: "cm-kid-" + tag, cwd, ...DOC, parent } as never })).callsign;
  made.push(child);
  await Promise.all([idle(parent), idle(child)]);
  await turn(parent, `Вызови инструмент message сервера fleet один раз: to — ${child}, text — «Ответь одним словом: принято». После вызова ничего больше не делай и ничего не пиши другим сессиям.`);
  const tasks = await until("задача у дочери", async () => { const t = await incoming(child, parent, "task"); return t.length ? t : undefined; });
  const results = await until("итог у родителя", async () => { const r = await incoming(parent, child, "result"); return r.length ? r : undefined; });
  return `задач у дочери ${tasks.length}, итог: ${results[0]!.slice(0, 60)}`;
});

await step("история через сервер инструментов: подписей и счётчиков нет, номер события на месте; строка о вызове — в истории флота", async () => {
  const raw = JSON.stringify(await api.call(sessionHistory, { to: child, limit: 50 }));
  const text = (await mcp("tools/call", { name: "session_history", arguments: { to: child, limit: 50 } })).content[0].text as string;
  for (const word of ['"signature"', '"usage"', '"modelUsage"', '"session_id"']) if (text.includes(word)) throw new Error(`в ответе модели осталось ${word}`);
  if (!text.includes('"uuid"')) throw new Error("номера события нет");
  const line = await until("строка журнала", async () => (await api.call(logQuery, { msg: "tool", limit: 20 })).lines.find((l) => String(JSON.stringify(l)).includes("session_history")), 60_000);
  return `знаков: странице ${raw.length}, модели ${text.length} (${(raw.length / text.length).toFixed(1)}×); строка: ${JSON.stringify(line).slice(0, 110)}`;
});

await step("дочь с фоновой командой отвечает дважды — оба итога у родителя", async () => {
  await idle(parent);
  const before = (await incoming(parent, child, "result")).length;
  await turn(parent, `Вызови инструмент message сервера fleet один раз: to — ${child}, text — «Запусти инструментом Bash команду sleep 25 && echo fon-gotov с параметром run_in_background: true. Сразу после запуска ответь одним словом: запустила. Когда придёт уведомление о конце фоновой команды, ответь: фон кончился.». После вызова ничего больше не делай и ничего не пиши другим сессиям.`);
  const got = await until("два итога дочери", async () => { const r = await incoming(parent, child, "result"); return r.length >= before + 2 ? r.slice(before) : undefined; }, 240_000);
  return got.map((t) => t.replace(/\s+/g, " ").slice(0, 40)).join(" ‖ ");
});

await step("подмена Host посреди хода дочери — итог дошёл родителю, задача не пришла дважды", async () => {
  await Promise.all([idle(parent), idle(child)]);
  const before = (await incoming(parent, child, "result")).length;
  const tasks = (await incoming(child, parent, "task")).length;
  await api.call(message, { to: parent, text: `Вызови инструмент message сервера fleet один раз: to — ${child}, text — «Выполни инструментом Bash команду sleep 40 && echo podmena (не в фоне) и ответь: подмена пережита». После вызова ничего больше не делай.` });
  await until("дочь занята", async () => (await rowOf(child))?.state === "busy", 120_000);
  await api.call(hostRestart, { to: `.keeper@${machine}` });
  const got = await until("итог после подмены", async () => { const r = await incoming(parent, child, "result"); return r.length > before ? r.slice(before) : undefined; }, 300_000);
  const now = (await incoming(child, parent, "task")).length;
  if (now !== tasks + 1) throw new Error(`задач у дочери ${tasks} → ${now}: ждали ровно одну новую`);
  return `итог: ${got[0]!.replace(/\s+/g, " ").slice(0, 50)}; задач у дочери ${tasks} → ${now}`;
});

await step("справка прочитана: сессия по просьбе читает страницу практик и называет инструмент", async () => {
  await idle(child);
  await turn(child, "Прочитай ресурс fleet://guide/practices сервера fleet инструментом чтения ресурсов MCP и назови одной строкой имя инструмента, которым сессия убирает сама себя.");
  const a = await lastAnswer(child);
  if (!a.includes("session_remove")) throw new Error("ответ: " + a.slice(0, 120));
  return a.replace(/\s+/g, " ").slice(0, 80);
});

await step("правила пережили сжатие: сессия называет свой позывной и инструмент ответа соседу", async () => {
  await api.call(sessionCall, { to: child, method: "compact" });
  await sleep(5000);
  await idle(child);
  await turn(child, "Назови одной строкой свой позывной во флоте и имя инструмента, которым отвечают на сообщение другой сессии (kind message).");
  const a = await lastAnswer(child);
  if (!a.includes(child) || !/\bmessage\b/.test(a)) throw new Error("ответ: " + a.slice(0, 120));
  return a.replace(/\s+/g, " ").slice(0, 90);
});

for (const cs of made.reverse()) await api.call(sessionRemove, { to: cs }).catch(() => {});
console.log(`\n${total - bad} из ${total}`);
process.exit(bad ? 1 : 0);
