// Живая проверка отката разговора: node tools/fleet/live-rewind.ts [флот] [устройство] [машина]
// Одна сессия на ключе флота: три хода правят файл; откат «разговор и файлы» дважды подряд, затем «только разговор», показ, очистка;
// пара: ведущая читает историю ведомого, сжимает и откатывает его инструментами и получает вести; разговоры папки.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallError, createApi, fleetList, httpTransport, machineConversations, message, sessionCall, sessionHistory, sessionOpen, sessionRemove, sessionRewind, sessionStart, sessionStop, shellRun, type SessionRow } from "@sb/protocol";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const [fleet = "test", device = "cli", machine = "devbox"] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const wire = httpTransport({ base: env.SB2_BASE!, key });
const api = createApi({ ...wire, call: async (f) => { for (let i = 0; ; i++) { const r = await wire.call(f); if (r.ok || r.error !== "offline" || i >= 4) return r; await new Promise((x) => setTimeout(x, 3000)); } } });
const SEAT = "muse";
const tag = Date.now().toString(36).slice(-4);
const cwd = machine === "wsl" ? `/tmp/sb2-rewind-${tag}` : `C:/Users/${os.userInfo().username}/AppData/Local/Temp/sb2-rewind-${tag}`;

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
const rowOf = async (cs: string): Promise<SessionRow | undefined> => (await api.call(fleetList, { machine })).sessions.find((s) => s.callsign === cs);
async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await sleep(1500);
  }
}
const idle = (cs: string) => until(`${cs} свободна`, async () => (await rowOf(cs))?.state === "idle");
/** Ход: сообщение ушло, сессия поработала и освободилась. */
async function turn(cs: string, text: string): Promise<string> {
  const r = await api.call(message, { to: cs, text });
  await until(`${cs} взяла ход`, async () => ["busy", "waiting"].includes((await rowOf(cs))?.state ?? ""), 30_000).catch(() => {});
  await idle(cs);
  return r.uuid;
}
const said = async (cs: string) => (await api.call(sessionHistory, { to: cs, limit: 200 })).events as Array<{ type: string; uuid?: string; text?: string; message?: { content?: unknown } }>;
const humans = async (cs: string) => (await said(cs)).filter((e) => e.type === "user" && typeof e.message?.content === "string" && !String(e.message.content).startsWith("<"));
/** Содержимое файла папки сессии глазами машины. */
async function file(name: string): Promise<string> {
  const r = await api.call(shellRun, { to: "@" + machine, shell: "node", script: `import fs from "node:fs";const p=${JSON.stringify(cwd + "/" + name)};process.stdout.write(fs.existsSync(p)?fs.readFileSync(p,"utf8"):"")`, wait: 30 });
  return String((r as { out?: string }).out ?? "").trim();
}

let cs = "";
let u1 = "", u2 = "", u3 = "";
await step("сессия на ключе флота: три хода правят один файл", async () => {
  cs = (await api.call(sessionOpen, { to: "@" + machine, spec: { name: "rw-" + tag, cwd, slot: SEAT } as never, mkdir: true })).callsign;
  made.push(cs);
  await idle(cs);
  u1 = await turn(cs, "Создай инструментом Write файл note.txt ровно с одной строкой: один. Больше ничего не делай.");
  u2 = await turn(cs, "Перезапиши инструментом Write файл note.txt ровно с двумя строками: один и два. Больше ничего не делай.");
  u3 = await turn(cs, "Перезапиши инструментом Write файл note.txt ровно с тремя строками: один, два и три. Больше ничего не делай.");
  const text = await file("note.txt");
  if (!/три/.test(text)) throw new Error("файл после трёх ходов: " + JSON.stringify(text));
  return `людских сообщений ${(await humans(cs)).length}, файл: ${text.replace(/\s+/g, " ")}`;
});

await step("показ: записи и файлы до отката, ничего не тронуто", async () => {
  const before = (await said(cs)).length;
  const r = await api.call(sessionRewind, { to: cs, upto: u3, files: true, dry: true });
  if (r.nofiles) throw new Error("снимка файлов нет: " + r.nofiles);
  if (!r.cut || !r.files?.length || r.text === undefined) throw new Error("показ: " + JSON.stringify(r));
  if ((await said(cs)).length !== before || !/три/.test(await file("note.txt"))) throw new Error("показ тронул разговор или файл");
  return `уйдёт записей ${r.cut}, файлов ${r.files.length}, текст «${r.text.slice(0, 30)}…»`;
});

await step("откат «разговор и файлы» к третьему сообщению: файл вернулся, лента обрезана, сессия та же", async () => {
  const before = (await humans(cs)).length;
  const r = await api.call(sessionRewind, { to: cs, upto: u3, files: true });
  await idle(cs);
  const text = await file("note.txt");
  if (/три/.test(text) || !/два/.test(text)) throw new Error("файл не вернулся: " + JSON.stringify(text));
  const after = await humans(cs);
  if (after.length !== before - 1 || after.some((e) => e.uuid === u3)) throw new Error(`в разговоре людских сообщений ${after.length}, было ${before}`);
  if (!(await said(cs)).some((e) => e.type === "conversation_reset" && /Откат к/.test(e.text ?? ""))) throw new Error("следа отката в истории нет");
  if (!(await rowOf(cs))) throw new Error("сессии с тем же позывным нет");
  return `ушло ${r.cut}, файл: ${text.replace(/\s+/g, " ")}, людских сообщений ${before} → ${after.length}`;
});

await step("второй откат подряд с файлами — к более раннему сообщению: файл вернулся 2 раза из 2", async () => {
  const r = await api.call(sessionRewind, { to: cs, upto: u2, files: true });
  await idle(cs);
  const text = await file("note.txt");
  if (/два|три/.test(text) || !/один/.test(text)) throw new Error("файл не вернулся: " + JSON.stringify(text));
  const after = await humans(cs);
  if (after.length !== 1) throw new Error(`людских сообщений ${after.length}, ждали 1`);
  return `ушло ${r.cut}, файл: ${text.replace(/\s+/g, " ")}`;
});

await step("обрезка переживает остановку и запуск сессии до первого нового хода", async () => {
  await api.call(sessionStop, { to: cs });
  await api.call(sessionStart, { to: cs });
  await idle(cs);
  const n = (await humans(cs)).length;
  if (n !== 1) throw new Error(`после перезапуска людских сообщений ${n}, ждали 1`);
  return "людских сообщений 1";
});

await step("сессия после отката помнит оставшееся и не помнит ушедшее", async () => {
  await turn(cs, "Ответь одним словом без инструментов: сколько строк ты записал в note.txt последним своим действием в этом разговоре — одну, две или три?");
  const last = (await said(cs)).filter((e) => e.type === "assistant").at(-1);
  const text = JSON.stringify(last?.message?.content ?? "").toLowerCase();
  if (!/одн|1/.test(text) || /тр[иё]|две|два/.test(text)) throw new Error("ответ: " + text.slice(0, 160));
  return "ответ: одну";
});

await step("откат «только разговор»: файл на диске прежний", async () => {
  const u = await turn(cs, "Перезапиши инструментом Write файл note.txt ровно с одной строкой: четыре. Больше ничего не делай.");
  if (!/четыре/.test(await file("note.txt"))) throw new Error("ход не записал файл");
  const r = await api.call(sessionRewind, { to: cs, upto: u });
  await idle(cs);
  if (!/четыре/.test(await file("note.txt"))) throw new Error("файл изменился при откате без файлов");
  if ((await humans(cs)).some((e) => e.uuid === u)) throw new Error("сообщение осталось в разговоре");
  return `ушло ${r.cut}, файл прежний`;
});

await step("сообщения с таким номером нет — отказ not_found, сессия работает", async () => {
  const r = await api.call(sessionRewind, { to: cs, upto: "00000000-0000-4000-8000-000000000000" }).then(() => "ok", (e) => (e as CallError).word);
  if (r !== "not_found") throw new Error("ответ: " + r);
  return (await rowOf(cs))!.state;
});

await step("разговоры папки: разговор сессии в списке и помечен её позывным", async () => {
  const r = await api.call(machineConversations, { to: "@" + machine, cwd });
  const mine = r.conversations.find((c) => c.live === cs);
  if (!mine) throw new Error("разговора сессии нет в списке: " + JSON.stringify(r.conversations.map((c) => [c.title.slice(0, 20), c.live])));
  return `разговоров ${r.conversations.length}, первая реплика «${mine.title.slice(0, 40)}»`;
});

await step("очистка: история пуста, сессия та же", async () => {
  await api.call(sessionRewind, { to: cs });
  await until("история пуста", async () => (await humans(cs)).length === 0, 60_000);
  await idle(cs);
  return `записей ${(await said(cs)).length}`;
});

/* Пара */
let lead = "", wing = "";
await step("пара: ведущая сжимает и откатывает ведомого инструментами и получает вести", async () => {
  const o = await api.call(sessionOpen, { to: "@" + machine, spec: { name: "rwlead-" + tag, cwd, slot: SEAT } as never, pair: true });
  lead = o.callsign;
  wing = o.wing!;
  made.push(lead);
  await idle(lead);
  await idle(wing);
  await turn(lead, `Дай ведомому ${wing} инструментом message задачу: «Ответь одним словом: готов». Дождись его итога и ответь мне одним словом: принято.`);
  await idle(wing);
  await turn(lead, `Сделай по порядку и ничего больше: 1) инструментом session_history прочитай разговор ${wing}; 2) инструментом session_call с method compact сожми ${wing}; 3) инструментом session_rewind без upto очисти разговор ${wing}. В конце ответь, сколько сообщений было в истории ведомого.`);
  await sleep(5000);
  const got = (await said(lead)).map((e) => JSON.stringify(e.message?.content ?? "")).filter((t) => t.includes("Ведомый"));
  const has = (w: string) => got.some((t) => t.includes(w));
  if (!has("очищен")) throw new Error("вести об очистке нет: " + got.map((t) => t.slice(0, 80)).join(" | "));
  return `вестей ведущей ${got.length}: ${["открыт", "сжат", "очищен"].filter(has).join(", ")}`;
});

await step("метод вне закрытого списка от сессии — отказ; от человека — проходит", async () => {
  const mine = await api.call(sessionCall, { to: wing, method: "permissionRules" }).then(() => "ok", (e) => (e as CallError).word);
  if (mine !== "ok") throw new Error("человеку отказано: " + mine);
  return "человеку — ok (отказ сессии закреплён тестом Host)";
});

for (const c of made) await api.call(sessionRemove, { to: c }).catch(() => {});
await api.call(shellRun, { to: "@" + machine, shell: "node", script: `import fs from "node:fs";fs.rmSync(${JSON.stringify(cwd)},{recursive:true,force:true})`, wait: 30 }).catch(() => {});
console.log(bad ? `сбоев: ${bad} из ${total}` : `откат: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
