// Живые сценарии флота поверх своих тестовых сессий: node tools/fleet/live-steps.ts <флот> <устройство> <машина> [вторая машина]
// Вопрос сессии и ответ (режим ask), пара, остановка и старт, откат файлов, скрипт на машине, обращение (инцидент), перезапуск Host
// с сохранением сессий, очереди аккаунтов. Сессии открываются на ключе флота muse и убираются за собой. Шаг, которому нужна более новая сборка
// на машине, помечается «ждёт выкладки» и сбоем не считается.
import fs from "node:fs";
import path from "node:path";
import { dev, fleetEnv } from "../dev.mjs";
import { lacks, machineTmp, newTag } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";
import {
  answer, CallError, createApi, fleetList, hostRestart, httpTransport, keeperState, machineMetrics, obsHealth, pointsDelete, pointsList, prefsGet, prefsSet, profileList, profileSync, PROXY_RULES, rulesTest,
  sessionCall, sessionHistory, sessionOpen, sessionRemove, sessionRewind, sessionStart, sessionStop, sessionUpdate, shellInfo, shellRun, keysModels, type SessionRow,
} from "@sb/protocol";

const dir = dev;
const env = fleetEnv;
const [fleet = "test", device = "cli", machine = "devbox", second = ""] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const api = createApi(httpTransport({ base: env.SB2_BASE!, key }));
/** Провайдер тестовых сессий — ключ флота; модель — SB2_MODEL или первая из его каталога. */
const SEAT = process.env.SB2_KEY ?? "muse";
const DOC = { key: SEAT, model: process.env.SB2_MODEL ?? (await api.call(keysModels, { name: SEAT })).models[0]!.id };

let bad = 0, waits = 0;
const made: string[] = [];
class Later extends Error {}
const later = (why: string): never => {
  throw new Later(why);
};
async function step(label: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    if (e instanceof Later) {
      waits++;
      console.log(`… ${label} · ждёт выкладки: ${e.message}`);
    } else {
      bad++;
      console.log(`✗ ${label} · ${e instanceof CallError ? `${e.word}: ${e.why ?? ""}` : (e as Error).message.split("\n")[0]}`);
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowOf = async (cs: string): Promise<SessionRow | undefined> => ((await api.call(fleetList, { machine: cs.split("@")[1]!, full: true })).sessions as SessionRow[]).find((s) => s.callsign === cs);
async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await sleep(1500);
  }
}
const tmps = new Map<string, string>();
const tmp = (m: string) => tmps.get(m) ?? (tmps.set(m, machineTmp(fleet, device, m) + "/sb2-live-steps"), tmps.get(m)!);
async function open(name: string, m: string, extra: Record<string, unknown> = {}, prompt?: string): Promise<string> {
  const r = await api.call(sessionOpen, { to: "@" + m, spec: { name, cwd: tmp(m), ...DOC, ...extra } as never, mkdir: true, number: true, ...(prompt ? { prompt } : {}) });
  made.push(r.callsign);
  return r.callsign;
}
const tag = newTag();
// части проверки: one — шаги на своей машине; far — шаги, которым нужна вторая машина (идут в одной очереди с перезапуском её Host)
const PART = process.env.SB2_PART ?? "";
const skip = async () => {};
const stepOne = !PART || PART === "one" ? step : skip;
const stepFar = !PART || PART === "far" ? step : skip;

/* Скрипт на машине */
for (const m of [machine, second].filter(Boolean)) {
  await step(`скрипт на машине ${m}`, async () => {
    const info = await api.call(shellInfo, { to: "@" + m });
    const r = await api.call(shellRun, { to: "@" + m, script: "echo sb2-" + tag, wait: 30 });
    if (r.state !== "done" || !(r.out ?? r.stdout ?? "").includes("sb2-" + tag)) throw new Error(`состояние ${r.state}, вывод: ${(r.out ?? "").slice(0, 80)}`);
    return `${info.os}, вывод получен`;
  });
}

/* Вопрос сессии и ответ: режим ask — запись файла ждёт разрешения человека */
let asker = "";
let askTo: string | undefined;
await stepOne("вопрос сессии: разрешение в строке, ответ человека, ход продолжается", async () => {
  asker = await open("ask-" + tag, machine, { mode: "ask" }, script(tool("Write", { file_path: `${tmp(machine)}/ask-${tag}.txt`, content: "ok" }), say("записан")));
  const row = await until("вопрос в строке сессии", async () => {
    const r = await rowOf(asker);
    return r?.ask ? r : r?.state === "failed" ? Promise.reject(new Error("сессия failed: " + r.error)) : undefined;
  });
  const ask = row.ask!;
  askTo = ask.to;
  await api.call(answer, { to: asker, ask: ask.id, answer: "allow" });
  // модель может спросить ещё раз (вторая команда того же хода): каждому новому вопросу — тот же ответ
  let asked = 1, last = ask.id;
  await until("вопрос снят и ход закончен", async () => {
    const r = await rowOf(asker);
    if (r?.ask && r.ask.id !== last) {
      last = r.ask.id;
      asked++;
      await api.call(answer, { to: asker, ask: last, answer: "allow" });
    }
    return r && !r.ask && r.state === "idle";
  }, 180_000);
  return `вид ${ask.kind}, инструмент ${ask.tool ?? "—"}${ask.to ? ", адресат " + ask.to : ""}, вопросов ${asked}`;
});
await stepOne("вопрос назван по адресату: в строке — кому он задан", async () => {
  if (!asker) throw new Error("сессии с вопросом нет");
  if (!askTo) later("Host этой сборки не пишет в вопрос адресата (ask.to)");
  return `адресат ${askTo}`;
});

/* Остановка и старт */
await stepOne("остановка и старт: разговор возобновляется", async () => {
  if (!asker) throw new Error("сессии нет");
  await api.call(sessionStop, { to: asker });
  await until("stopped", async () => (await rowOf(asker))?.state === "stopped", 60_000);
  await api.call(sessionStart, { to: asker });
  await until("idle после старта", async () => (await rowOf(asker))?.state === "idle", 90_000);
  const h = await api.call(sessionHistory, { to: asker, limit: 50 });
  if (!h.events.length) throw new Error("после старта история пуста");
  return `событий в истории ${h.events.length}`;
});

/* Откат файлов */
await stepOne("откат к сообщению: показ без отката — сколько записей и файлов уйдёт", async () => {
  if (!asker) throw new Error("сессии нет");
  const h = await api.call(sessionHistory, { to: asker, limit: 100 });
  const first = h.events.find((e) => e.type === "user" && typeof (e as { message?: { content?: unknown } }).message?.content === "string" && e.uuid);
  if (!first?.uuid) throw new Error("нет сообщения человека с uuid");
  const r = await api.call(sessionRewind, { to: asker, upto: first.uuid, files: true, dry: true });
  return `уйдёт записей ${r.cut}, файлов ${r.files?.length ?? 0}`;
});

/* Пара */
await stepOne("пара: ведомый открыт вместе с ведущим, в строке ведомого — ведущий; снятие пары", async () => {
  const lead = await open("lead-" + tag, machine);
  let wing = "";
  try {
    const r = await api.call(sessionUpdate, { to: lead, patch: {}, pair: true } as never);
    wing = (r as { wing?: string }).wing ?? "";
  } catch (e) {
    if (e instanceof CallError && e.word === "bad_input") later("session.update без pair на этой сборке Host");
    throw e;
  }
  if (!wing) throw new Error("ведомый не назван в ответе");
  made.push(wing);
  const row = await until("строка ведомого", async () => rowOf(wing), 60_000);
  if ((row as { lead?: string }).lead !== lead) throw new Error(`у ведомого ведущий ${(row as { lead?: string }).lead}`);
  await api.call(sessionUpdate, { to: lead, patch: { wing: null } } as never);
  await until("ведомый убран", async () => !(await rowOf(wing)), 60_000);
  return `${lead} ▸ ${wing}`;
});

/* Правило прокси: текст запроса к модели правится по правилу флота */
await stepOne("правило прокси: слово в запросе к модели заменено по правилу флота", async () => {
  const rules = ((await api.call(prefsGet, { scope: "fleet", prefix: PROXY_RULES })).values[PROXY_RULES] ?? []) as unknown[];
  const mark = "SB2MARK" + tag.toUpperCase(), word = "заменено-" + tag;
  await api.call(prefsSet, { scope: "fleet", name: PROXY_RULES, value: [...rules, { name: "live-" + tag, scopes: ["user"], kind: "literal", unit: "match", action: "replace", pattern: mark, replacement: word }] });
  try {
    await until("машина прочла правило", async () => (await api.call(rulesTest, { to: "@" + machine, text: mark })).after === word, 30_000);
    // сессии сказано повторить метку; модель видит запрос после правила — и повторяет уже замену
    const cs = await open("rule-" + tag, machine, {}, script(say("слово: " + mark)));
    const row = await until("сессия ответила", async () => { const r = await rowOf(cs); return r?.state === "idle" && r.result ? r : undefined; });
    const said = String(row.result);
    if (!said.includes(word) || said.includes(mark)) throw new Error("ответ модели: " + said.slice(0, 120));
    return `${mark} → ${said.slice(0, 40)}`;
  } finally {
    await api.call(prefsSet, { scope: "fleet", name: PROXY_RULES, value: rules }).catch(() => {});
  }
});

/* Точка после остановки и поиск по переписке */
let archived: { sid: string; word: string } | undefined;
// точка и поиск: блоки разговора идут в хранилище по подписанным ссылкам
if (!lacks("r2")) await stepOne("точка после остановки: остановленная сессия сохранена в архив, сбоя точки в строке нет", async () => {
  const word = "маяк" + tag;
  const cs = await open("point-" + tag, machine, { backup: true }, script(say(word)));
  await until("ход закончен", async () => {
    const r = await rowOf(cs);
    return r?.state === "failed" ? Promise.reject(new Error("сессия failed: " + r.error)) : r?.state === "idle" && !!r.last;
  });
  await api.call(sessionStop, { to: cs });
  await until("stopped", async () => (await rowOf(cs))?.state === "stopped", 60_000);
  const s = await until("сессия в архиве", async () => (await api.call(pointsList, { machine })).sessions.find((x) => x.callsign === cs && x.points > 0), 60_000);
  const row = await rowOf(cs);
  if (row?.archiveError) throw new Error("точка не сохранилась: " + row.archiveError);
  archived = { sid: s.sid, word };
  return `точек ${s.points}`;
});
if (!lacks("r2")) await stepOne("поиск по слову называет запись разговора и точку, с которой она в архиве", async () => {
  if (!archived) throw new Error("сохранённой сессии нет");
  const { sid, word } = archived;
  const r = await until("сессия найдена поиском", async () => (await api.call(pointsList, { q: word })).sessions.find((x) => x.sid === sid), 30_000);
  if (!r.hitUuid) later("службы этой выкладки не называют запись (hitUuid)");
  if (!r.hitPoint) throw new Error("запись названа, точка — нет");
  if (!r.hit?.includes(word)) throw new Error("строка вокруг слова без самого слова: " + r.hit);
  return `запись ${r.hitUuid!.slice(0, 8)}, точка ${r.hitPoint}, строка «${r.hit}»`;
});
if (archived) await api.call(pointsDelete, { sid: archived.sid }).catch(() => {});

/* Числа Host в наблюдении */
await stepOne("числа Host: машина отвечает на запрос, служба наблюдения несёт её последнее окно", async () => {
  const now = await api.call(machineMetrics, { to: "@" + machine }).catch((e) => (e instanceof CallError && e.word === "unknown_request" ? later(`Host на ${machine} не знает machine.metrics`) : Promise.reject(e)));
  const h = await api.call(obsHealth, {});
  const mine = h.hosts?.find((x) => x.machine === machine);
  if (!mine) later("служба наблюдения ещё не получала числа Host этой машины");
  return `сессий ${Object.values(now.sessions).reduce((a, b) => a + b, 0)}, очередь ${now.queue}; в сводке — окно от ${new Date(mine!.at).toISOString().slice(11, 19)}`;
});

/* Кусочки: правка пришла с другой машины — работающая сессия перечитывает скилы */
// репозиторий кусочков машины берут с GitHub
if (second && !lacks("github")) {
  await stepFar("кусочки обновились на другой машине — работающая сессия видит новый скил", async () => {
    const far = (await api.call(profileList, { to: "@" + second })).repos?.find((r) => r.state === "ok" && r.dir);
    const piece = (await api.call(profileList, { to: "@" + machine })).pieces.find((p) => p.ok && far && p.repo === far.repo && (p.has?.skill ?? 0) > 0);
    if (!far || !piece) throw new Error("на машинах нет общего сведённого репозитория кусочков со скилами");
    const folder = piece.id.split("/").pop()!;
    const cs = await open("skills-" + tag, machine, { pieces: [piece.id] });
    await until("сессия свободна", async () => (await rowOf(cs))?.state === "idle");
    const skill = "live-" + tag;
    const names = async () => JSON.stringify(await api.call(sessionCall, { to: cs, method: "commands" }));
    if ((await names()).includes(skill)) throw new Error("скил уже есть до правки");
    const write = (rm: boolean) => api.call(shellRun, { to: "@" + second, shell: "node", wait: 30, script: `import fs from "node:fs";const d=${JSON.stringify(far.dir + "/" + folder + "/skills/" + skill)};${rm ? "fs.rmSync(d,{recursive:true,force:true});" : `fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+"/SKILL.md","---\\nname: ${skill}\\ndescription: живая проверка перечитывания\\n---\\nтекст\\n");`}` });
    await write(false);
    await api.call(profileSync, { to: "@" + second });
    await api.call(profileSync, { to: "@" + machine });
    try {
      await until("скил виден сессии", async () => (await names()).includes(skill), 60_000);
    } finally {
      await write(true);
      await api.call(profileSync, { to: "@" + second }).catch(() => {});
      await api.call(profileSync, { to: "@" + machine }).catch(() => {});
    }
    return `${piece.id}: скил ${skill} появился`;
  });
}

/* Уборка */
for (const cs of made.reverse()) await api.call(sessionRemove, { to: cs }).catch(() => {});
console.log(bad ? `сбоев: ${bad}` : `сценарии пройдены${waits ? `; ждут выкладки: ${waits}` : ""}`);
process.exit(bad ? 1 : 0);
