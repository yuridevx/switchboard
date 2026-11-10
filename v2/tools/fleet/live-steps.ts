// Живые сценарии флота поверх своих тестовых сессий: node tools/fleet/live-steps.ts <флот> <устройство> <машина> [вторая машина]
// Вопрос сессии и ответ (режим ask), пара, остановка и старт, откат файлов, скрипт на машине, обращение (инцидент), перезапуск Host
// с сохранением сессий. Сессии открываются на ключе флота deepseek и убираются за собой. Шаг, которому нужна более новая сборка
// на машине, помечается «ждёт выкладки» и сбоем не считается.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  answer, CallError, createApi, fleetList, hostRestart, httpTransport, incidentList, incidentRaise, keeperState, prefsGet, prefsSet,
  sessionCall, sessionHistory, sessionOpen, sessionRemove, sessionStart, sessionStop, sessionUpdate, shellInfo, shellRun, type SessionRow,
} from "@sb/protocol";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const [fleet = "test", device = "cli", machine = "devbox", second = ""] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const api = createApi(httpTransport({ base: env.SB2_BASE!, key }));
const ACCOUNT = "deepseek";

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
const rowOf = async (cs: string): Promise<SessionRow | undefined> => (await api.call(fleetList, { machine: cs.split("@")[1]! })).sessions.find((s) => s.callsign === cs);
async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await sleep(1500);
  }
}
const tmp = (m: string) => (m === "wsl" ? "/tmp/sb2-live-steps" : "C:/Users/" + os.userInfo().username + "/AppData/Local/Temp/sb2-live-steps");
async function open(name: string, m: string, extra: Record<string, unknown> = {}, prompt?: string): Promise<string> {
  const r = await api.call(sessionOpen, { to: "@" + m, spec: { name, cwd: tmp(m), account: ACCOUNT, ...extra } as never, mkdir: true, number: true, ...(prompt ? { prompt } : {}) });
  made.push(r.callsign);
  return r.callsign;
}
const tag = Date.now().toString(36).slice(-4);

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
await step("вопрос сессии: разрешение в строке, ответ человека, ход продолжается", async () => {
  asker = await open("ask-" + tag, machine, { mode: "ask" }, `Создай файл ask-${tag}.txt со словом ok и больше ничего не делай.`);
  const row = await until("вопрос в строке сессии", async () => {
    const r = await rowOf(asker);
    return r?.ask ? r : r?.state === "failed" ? Promise.reject(new Error("сессия failed: " + r.error)) : undefined;
  });
  const ask = row.ask!;
  askTo = ask.to;
  await api.call(answer, { to: asker, ask: ask.id, answer: "allow" });
  await until("вопрос снят и ход закончен", async () => {
    const r = await rowOf(asker);
    return r && !r.ask && r.state === "idle";
  });
  return `вид ${ask.kind}, инструмент ${ask.tool ?? "—"}${ask.to ? ", адресат " + ask.to : ""}`;
});
await step("вопрос назван по адресату: в строке — кому он задан", async () => {
  if (!asker) throw new Error("сессии с вопросом нет");
  if (!askTo) later("Host этой сборки не пишет в вопрос адресата (ask.to)");
  return `адресат ${askTo}`;
});

/* Остановка и старт */
await step("остановка и старт: разговор возобновляется", async () => {
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
await step("откат файлов к сообщению: проба числа файлов", async () => {
  if (!asker) throw new Error("сессии нет");
  const h = await api.call(sessionHistory, { to: asker, limit: 100 });
  const first = h.events.find((e) => e.type === "user" && typeof (e as { message?: { content?: unknown } }).message?.content === "string" && e.uuid);
  if (!first?.uuid) throw new Error("нет сообщения человека с uuid");
  const r = await api.call(sessionCall, { to: asker, method: "rewindFiles", args: { message: first.uuid, dryRun: true } });
  return `ответ SDK: ${JSON.stringify(r).slice(0, 120)}`;
});

/* Пара */
await step("пара: ведомый открыт вместе с ведущим, в строке ведомого — ведущий; снятие пары", async () => {
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

/* Обращение (инцидент) */
await step("обращение: вид из настроек флота открывает сессию; обращение видно в списке", async () => {
  const kinds = ((await api.call(prefsGet, { scope: "fleet", prefix: "incidents.kinds" })).values["incidents.kinds"] ?? {}) as Record<string, unknown>;
  const kind = "live-" + tag;
  await api.call(prefsSet, { scope: "fleet", name: "incidents.kinds", value: { ...kinds, [kind]: { cwd: tmp(machine), account: ACCOUNT, prompt: "Это проверка: ответь одним словом «принято»." } } });
  try {
    await sleep(3000); // Host перечитывает настройку по кадру «изменилось»
    const r = await api.call(incidentRaise, { to: "@" + machine, kind, key: "k1", text: "живая проверка обращения " + tag });
    if (r.callsign) made.push(r.callsign);
    const list = await api.call(incidentList, { to: "@" + machine });
    const mine = list.incidents.find((i) => i.id === r.id);
    if (!mine) throw new Error("обращения нет в списке");
    const port = (list as { port?: number }).port;
    return `сессия ${r.callsign ?? "—"}, состояние ${mine.state}${port ? `, локальный вход на порту ${port}` : ", локальный HTTP на машине не включён"}`;
  } finally {
    await api.call(prefsSet, { scope: "fleet", name: "incidents.kinds", value: kinds }).catch(() => {});
  }
});

/* Перезапуск Host с сохранением сессий */
await step("перезапуск Host: процесс новый, сессии на месте", async () => {
  const before = await api.call(keeperState, { to: ".keeper@" + machine });
  if (before.host.pid === undefined) later(`Keeper сборки ${before.build} на ${machine} не знает host.restart`);
  const sessions = (await api.call(fleetList, { machine })).sessions.map((s) => s.callsign).sort();
  await api.call(hostRestart, { to: ".keeper@" + machine });
  await until("новый процесс Host", async () => {
    const s = await api.call(keeperState, { to: ".keeper@" + machine }).catch(() => undefined);
    return s && s.host.state === "running" && s.host.pid !== before.host.pid;
  }, 120_000);
  const after = await until("машина снова в картине со своими сессиями", async () => {
    const l = await api.call(fleetList, { machine }).catch(() => undefined);
    return l?.machines[0]?.online ? l.sessions.map((s) => s.callsign).sort() : undefined;
  }, 120_000);
  if (JSON.stringify(after) !== JSON.stringify(sessions)) throw new Error(`сессии были ${sessions.join(",")}, стали ${after.join(",")}`);
  return `сессий ${after.length}`;
});

/* Уборка */
for (const cs of made.reverse()) await api.call(sessionRemove, { to: cs }).catch(() => {});
console.log(bad ? `сбоев: ${bad}` : `сценарии пройдены${waits ? `; ждут выкладки: ${waits}` : ""}`);
process.exit(bad ? 1 : 0);
