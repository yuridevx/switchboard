// Живые сценарии флота поверх своих тестовых сессий: node tools/fleet/live-steps.ts <флот> <устройство> <машина> [вторая машина]
// Вопрос сессии и ответ (режим ask), пара, остановка и старт, откат файлов, скрипт на машине, обращение (инцидент), перезапуск Host
// с сохранением сессий, очереди аккаунтов. Сессии открываются на ключе флота muse и убираются за собой. Шаг, которому нужна более новая сборка
// на машине, помечается «ждёт выкладки» и сбоем не считается.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accountList, answer, CallError, createApi, fleetList, hostRestart, httpTransport, incidentList, incidentRaise, keeperState, machineMetrics, obsHealth, pointsDelete, pointsList, prefsGet, prefsSet,
  sessionCall, sessionHistory, sessionOpen, sessionRemove, sessionStart, sessionStop, sessionUpdate, shellInfo, shellRun, slotSet, slotSwap, type SessionRow,
} from "@sb/protocol";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const [fleet = "test", device = "cli", machine = "devbox", second = ""] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const api = createApi(httpTransport({ base: env.SB2_BASE!, key }));
/** Ключ флота тестовых сессий. */
const SEAT = "muse";

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
  const r = await api.call(sessionOpen, { to: "@" + m, spec: { name, cwd: tmp(m), slot: SEAT, ...extra } as never, mkdir: true, number: true, ...(prompt ? { prompt } : {}) });
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
  await api.call(prefsSet, { scope: "fleet", name: "incidents.kinds", value: { ...kinds, [kind]: { cwd: tmp(machine), slot: SEAT, prompt: "Это проверка: ответь одним словом «принято»." } } });
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

/* Точка после остановки и поиск по переписке */
let archived: { sid: string; word: string } | undefined;
await step("точка после остановки: остановленная сессия сохранена в архив, сбоя точки в строке нет", async () => {
  const word = "маяк" + tag;
  const cs = await open("point-" + tag, machine, { backup: true }, `Ответь одним словом: ${word}`);
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
await step("поиск по слову называет запись разговора и точку, с которой она в архиве", async () => {
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
await step("числа Host: машина отвечает на запрос, служба наблюдения несёт её последнее окно", async () => {
  const now = await api.call(machineMetrics, { to: "@" + machine }).catch((e) => (e instanceof CallError && e.word === "unknown_request" ? later(`Host на ${machine} не знает machine.metrics`) : Promise.reject(e)));
  const h = await api.call(obsHealth, {});
  const mine = h.hosts?.find((x) => x.machine === machine);
  if (!mine) later("служба наблюдения ещё не получала числа Host этой машины");
  return `сессий ${Object.values(now.sessions).reduce((a, b) => a + b, 0)}, очередь ${now.queue}; в сводке — окно от ${new Date(mine!.at).toISOString().slice(11, 19)}`;
});

/* Очереди аккаунтов: несколько именованных очередей на машине */
{
  const queue = "live-" + tag;
  const word = async (fn: () => Promise<unknown>): Promise<string> => fn().then(() => "ok", (e) => (e instanceof CallError ? `${e.word}: ${e.why ?? ""}` : Promise.reject(e)));
  const slots = async () => (await api.call(accountList, { to: "@" + machine })).slots;
  let login = "", held = "";
  await step("очереди: вторая очередь на машине — у каждой свой порядок и тот, кто стоит сейчас", async () => {
    const list = await api.call(accountList, { to: "@" + machine });
    login = list.accounts.find((a) => a.kind === "claude" && a.ok)?.id ?? "";
    if (!login) later(`на ${machine} нет входа Claude — очередь не из кого завести`);
    if (!list.slots.some((q) => q.name === "main")) throw new Error("очереди main нет: " + list.slots.map((q) => q.name).join(", "));
    await api.call(slotSet, { to: "@" + machine, slot: queue, order: [login] });
    const now = await slots();
    const mine = now.find((q) => q.name === queue);
    if (!mine || mine.account !== login || mine.order.join() !== login) throw new Error("новая очередь: " + JSON.stringify(mine));
    return now.map((q) => `${q.name} → ${q.account ?? "пусто"}`).join(" · ");
  });
  await step("очереди: сессия во второй очереди идёт на её аккаунте; имя очереди — в документе", async () => {
    if (!login) later("нет входа Claude");
    const r = await api.call(sessionOpen, { to: "@" + machine, spec: { name: "q" + tag, cwd: tmp(machine), slot: queue } as never, mkdir: true });
    held = r.callsign;
    made.push(held);
    const row = await until("строка сессии с аккаунтом очереди", async () => { const x = await rowOf(held); return x?.account === login ? x : undefined; }, 60_000);
    if (row.spec.slot !== queue) throw new Error("в документе очередь " + row.spec.slot);
    const mine = (await slots()).find((q) => q.name === queue);
    if (mine?.sessions !== 1) throw new Error("на очереди сессий: " + mine?.sessions);
    return `${held}: slot ${row.spec.slot}, идёт на ${row.account}`;
  });
  await step("очереди: открытие без названной очереди при двух — отказ slot_required с их именами; почта вместо очереди — no_slot", async () => {
    if (!login) later("нет входа Claude");
    const none = await word(() => api.call(sessionOpen, { to: "@" + machine, spec: { name: "qn" + tag, cwd: tmp(machine) } as never }));
    if (!none.startsWith("slot_required") || !none.includes("main") || !none.includes(queue)) throw new Error("без очереди: " + none);
    const mail = await word(() => api.call(sessionOpen, { to: "@" + machine, spec: { name: "qm" + tag, cwd: tmp(machine), slot: login } as never }));
    if (!mail.startsWith("no_slot")) throw new Error("почта вместо очереди: " + mail);
    return `${none.split(":")[0]} · ${mail.split(":")[0]}`;
  });
  await step("очереди: «Сменить сейчас» идёт в названную очередь и другую не трогает; неизвестная очередь — no_slot", async () => {
    if (!login) later("нет входа Claude");
    const before = (await slots()).find((q) => q.name === "main")?.account;
    // вход на машине один: запаса в очереди нет — отказ приходит от названной очереди
    const swap = await word(() => api.call(slotSwap, { to: "@" + machine, slot: queue }));
    if (!swap.startsWith("no_reserve") || !swap.includes(queue)) throw new Error("смена в очереди без запаса: " + swap);
    const ghost = await word(() => api.call(slotSwap, { to: "@" + machine, slot: "nope-" + tag }));
    if (!ghost.startsWith("no_slot")) throw new Error("неизвестная очередь: " + ghost);
    const after = (await slots()).find((q) => q.name === "main")?.account;
    if (after !== before) throw new Error(`main сменилась: ${before} → ${after}`);
    return `${queue}: no_reserve · main осталась на ${after}`;
  });
  await step("очереди: очередь с сессией не удаляется; без сессий пустой порядок убирает её", async () => {
    if (!login) later("нет входа Claude");
    const busy = await word(() => api.call(slotSet, { to: "@" + machine, slot: queue, order: [] }));
    if (!busy.startsWith("has_sessions")) throw new Error("удаление очереди с сессией: " + busy);
    await api.call(sessionRemove, { to: held });
    await until("сессия убрана", async () => !(await rowOf(held)), 60_000);
    await api.call(slotSet, { to: "@" + machine, slot: queue, order: [] });
    const left = (await slots()).map((q) => q.name);
    if (left.includes(queue)) throw new Error("очередь осталась: " + left.join(", "));
    return `осталось: ${left.join(", ")}`;
  });
  // сбой посреди шагов не оставляет очередь на машине
  if (login) await api.call(slotSet, { to: "@" + machine, slot: queue, order: [] }).catch(() => {});
}

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
