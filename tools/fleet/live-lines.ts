// Живая проверка конвейера во флоте в коробке: node tools/fleet/live-lines.ts [флот] [устройство]
// Определение проекта коробки лежит в её репозитории кусочков (tools/box/factory.mjs): конвейер из трёх шагов с потолком два.
// Проверка применяет определение, кладёт на конвейер пять тикетов и ждёт, пока все пройдут три шага: свежая сессия → та же → свежая.
// Одновременно в работе — не больше потолка: это видно по загрузке конвейера во время прогона и по истории флота после него.
// В том же определении — пост-сторож и два правила входа раз в 10 секунд. Проверка первого возвращает 0: шесть сроков — ни тикета, ни работы
// сессиям, в истории шесть строк «тихо». Проверка второго возвращает 1: первая находка — тикет сторожу, следующие — заметки в тот же тикет.
// Третье правило — с адресом: POST на адрес с секретом заводит тикет сторожу, сторож его сдаёт; чужой секрет — 404. То же правило зовётся
// по имени: три события с одним ключом ложатся в один тикет. В конце фабрика проекта ставится на паузу: правила больше не срабатывают.
import fs from "node:fs";
import path from "node:path";
import { CallError, createApi, factoryApply, factoryGet, factoryPause, fleetList, hookUrl, httpTransport, logQuery, sessionRemove, ticketList, ticketNew, ticketSet } from "@sb/protocol";
import { DOOR, DOOR_NOTE, FOUND, FOUND_OUT, LINE, POST, PROJECT, QUIET, RULE_EVERY_S } from "../box/factory.mjs";
import { REPO } from "../box/github.mjs";
import { dev, fleetEnv } from "../dev.mjs";
import { lacks, newTag } from "./harness.mjs";

const [fleet = "box", device = "cli"] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dev, `v2-${fleet}-${device}.pass`), "utf8").trim();
const wire = httpTransport({ base: fleetEnv.SB2_BASE!, key });
const api = createApi({ ...wire, call: async (f) => { for (let i = 0; ; i++) { const r = await wire.call(f); if (r.ok || r.error !== "offline" || i >= 4) return r; await new Promise((x) => setTimeout(x, 3000)); } } });
const tag = newTag();
const TICKETS = 5, LIMIT = 2, STEPS = 3, QUIET_RUNS = 6, NOTES = 3;

let bad = 0;
async function step(label: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${e instanceof CallError ? `${e.word}: ${e.why ?? ""}` : (e as Error).message.split("\n")[0]}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ids: string[] = [];
await step("определение проекта применено из репозитория ролей", async () => {
  const r = await api.call(factoryApply, { project: PROJECT, repo: REPO });
  const f = (await api.call(factoryGet, { project: PROJECT })).factory!;
  const line = f.def.lines[LINE];
  if (f.commit !== r.commit || line?.limit !== LIMIT || line.steps.length !== STEPS) throw new Error(`применено не то: ${JSON.stringify({ commit: f.commit, line })}`);
  if (r.rules !== 3 || !f.next[QUIET] || !f.next[FOUND] || f.next[DOOR]) throw new Error(`правила входа не встали на часы: ${JSON.stringify({ rules: r.rules, next: f.next })}`);
  // прошлый прогон оставил фабрику на паузе
  await api.call(factoryPause, { project: PROJECT, on: false });
  return `коммит ${r.commit.slice(0, 7)}, конвейер «${line.title}»: шагов ${line.steps.length}, потолок ${line.limit}; правил входа ${r.rules}`;
});
const started = Date.now();
/** Тикеты, которые завело правило входа с начала этого прогона. */
const byRule = async (rule: string) => (await api.call(ticketList, { project: PROJECT })).tickets.filter((t) => t.on === rule && t.since >= started);
// сроки правила считаются по его ближайшему сроку: каждое срабатывание ставит следующий. Идёт рядом с конвейером — правила времени работу не ждут
const quiet = (async () => {
  const seen = new Set<number>();
  const end = Date.now() + (QUIET_RUNS + 6) * RULE_EVERY_S * 1000;
  while (seen.size <= QUIET_RUNS) {
    if (Date.now() > end) throw new Error(`за ${(QUIET_RUNS + 6) * RULE_EVERY_S} с правило сработало ${Math.max(0, seen.size - 1)} раз из ${QUIET_RUNS}`);
    seen.add((await api.call(factoryGet, { project: PROJECT })).factory!.next[QUIET]!);
    await sleep(2000);
  }
  return seen.size - 1;
})();
quiet.catch(() => {});
await step(`конвейер из ${STEPS} шагов при потолке ${LIMIT} проводит ${TICKETS} тикетов: одновременно в работе не больше ${LIMIT}`, async () => {
  for (let i = 1; i <= TICKETS; i++) ids.push((await api.call(ticketNew, { project: PROJECT, to: LINE, title: `Живая проверка конвейера ${tag} · ${i}` })).id);
  let peak = 0;
  const end = Date.now() + 200_000;
  for (;;) {
    const load = (await api.call(factoryGet, { project: PROJECT })).factory!.load.lines[LINE]!;
    peak = Math.max(peak, load.work);
    const mine = (await Promise.all(ids.map(async (id) => (await api.call(ticketList, { ticket: id })).tickets[0]!)));
    const stopped = mine.find((t) => t.state === "stop");
    if (stopped) throw new Error(`тикет ${stopped.id} встал на шаге ${stopped.step + 1}: ${stopped.why}`);
    if (mine.every((t) => t.state === "done")) {
      const verdicts = mine.map((t) => t.notes!.filter((n) => n.verdict === "done").length);
      if (verdicts.some((n) => n !== STEPS)) throw new Error(`вердиктов «сдал» у тикетов: ${verdicts.join(", ")}, ждали по ${STEPS}`);
      // шаг «довести» вела та же сессия, что «сделать»; «принять» — другая
      const sessions = mine.map((t) => t.notes!.filter((n) => n.verdict === "done").map((n) => n.by));
      if (sessions.some((s) => s[0] !== s[1] || s[2] === s[0])) throw new Error(`сессии шагов не те: ${JSON.stringify(sessions[0])}`);
      break;
    }
    if (Date.now() > end) throw new Error(`не дождался: закрыто ${mine.filter((t) => t.state === "done").length} из ${TICKETS}`);
    await sleep(1500);
  }
  if (peak > LIMIT || peak < 1) throw new Error(`в работе одновременно было ${peak}, потолок ${LIMIT}`);
  return `закрыто ${TICKETS} из ${TICKETS}, шагов сдано ${TICKETS * STEPS}, в работе одновременно до ${peak}`;
});
if (!lacks("clickhouse"))
  await step("история флота: по строкам «ticket» одновременно в работе не больше потолка", async () => {
    const mine = new Set(ids);
    let lines: { at: number; kind?: string }[] = [];
    // строки доходят не сразу: ждём все «дан» и «сдан» своих тикетов
    for (let i = 0; i < 20; i++) {
      lines = (await api.call(logQuery, { msg: "ticket", limit: 1000 })).lines.filter((l) => mine.has(String((l.data as { ticket?: string } | undefined)?.ticket)));
      if (lines.filter((l) => l.kind === "given").length >= TICKETS * STEPS && lines.filter((l) => l.kind === "done").length >= TICKETS * STEPS) break;
      await sleep(2000);
    }
    const given = lines.filter((l) => l.kind === "given").length, done = lines.filter((l) => l.kind === "done").length;
    if (given !== TICKETS * STEPS || done !== TICKETS * STEPS) throw new Error(`строк «дан» ${given}, «сдан» ${done}, ждали по ${TICKETS * STEPS}`);
    // в один момент сначала считается «сдан», потом «дан»: место освобождается раньше, чем его берут
    let now = 0, peak = 0;
    for (const l of lines.filter((x) => x.kind === "given" || x.kind === "done").sort((a, b) => a.at - b.at || (a.kind === "done" ? -1 : 1))) {
      now += l.kind === "given" ? 1 : -1;
      peak = Math.max(peak, now);
    }
    if (peak > LIMIT) throw new Error(`по истории в работе одновременно было ${peak}, потолок ${LIMIT}`);
    return `строк «дан» ${given}, «сдан» ${done}; одновременно в работе до ${peak}`;
  });
await step(`тихая проверка не будит: правило сработало ${QUIET_RUNS} раз — тикетов 0`, async () => {
  const runs = await quiet;
  const made = await byRule(QUIET);
  if (made.length) throw new Error(`тихое правило завело тикеты: ${made.map((t) => t.id).join(", ")}`);
  return `срабатываний ${runs}, тикетов 0`;
});
let found = "";
await step(`находка правила — тикет посту; следующие ${NOTES} находки — заметки в тот же тикет`, async () => {
  const end = Date.now() + (NOTES + 8) * RULE_EVERY_S * 1000;
  for (;;) {
    const made = await byRule(FOUND);
    if (made.length > 1) throw new Error(`правило завело ${made.length} тикета: ${made.map((t) => t.id).join(", ")}`);
    const t = made[0] && (await api.call(ticketList, { ticket: made[0].id })).tickets[0]!;
    const notes = (t?.notes ?? []).filter((n) => !n.verdict && n.text.includes(FOUND_OUT));
    // сторож позвал человека: тикет встал и открыт — находки идут в него
    if (t?.state === "stop" && t.why === "нужен человек" && notes.length >= NOTES) {
      if (t.to !== POST || !t.text.includes(FOUND_OUT)) throw new Error(`тикет не тот: ${JSON.stringify({ to: t.to, text: t.text.slice(-80) })}`);
      found = t.id;
      return `тикет ${t.id} посту «${POST}»: сторож поднят и позвал человека; заметок с находкой ${notes.length}, тикетов правила 1`;
    }
    if (Date.now() > end) throw new Error(`не дождался: ${t ? `тикет ${t.id} — ${t.state}${t.why ? ` (${t.why})` : ""}, заметок ${notes.length}` : "тикета правила нет"}`);
    await sleep(2000);
  }
});
let secret = "";
await step("событие на адрес с секретом — тикет посту, пост его сдаёт; чужой секрет — 404", async () => {
  const { url } = await api.call(hookUrl, { project: PROJECT, name: DOOR });
  secret = url.split("/").pop()!;
  const wrong = await fetch(url.slice(0, -secret.length) + "A".repeat(secret.length), { method: "POST", body: "чужой" });
  if (wrong.status !== 404) throw new Error(`чужой секрет: ответ ${wrong.status}, ждали 404`);
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "live-" + tag, text: `Событие живой проверки ${tag}` }) });
  const got = (await res.json()) as { id?: string; error?: string; why?: string };
  if (res.status !== 202 || !got.id) throw new Error(`событие не принято: ${res.status} ${got.error ?? ""} ${got.why ?? ""}`);
  const end = Date.now() + 90_000;
  for (;;) {
    const t = (await api.call(ticketList, { ticket: got.id })).tickets[0]!;
    if (t.state === "done") {
      const verdict = t.notes!.find((n) => n.verdict === "done");
      if (t.on !== DOOR || t.key !== "live-" + tag || t.to !== POST || verdict?.text !== DOOR_NOTE || !verdict.by.startsWith(POST + "@")) throw new Error(`тикет не тот: ${JSON.stringify({ on: t.on, key: t.key, to: t.to, verdict })}`);
      return `тикет ${t.id} по правилу «${DOOR}», сдал ${verdict.by}; чужой секрет — 404`;
    }
    if (t.state === "stop" || Date.now() > end) throw new Error(`тикет ${t.id} — ${t.state}${t.why ? `: ${t.why}` : ""}`);
    await sleep(1500);
  }
});
await step("правило зовут по имени: три события с одним ключом — один тикет", async () => {
  if (!found) throw new Error("тикета находки нет: звать не в кого");
  const was = (await api.call(ticketList, { ticket: found })).tickets[0]!.notes!.length;
  // ключ — тот же, что у находки по времени: её тикет открыт, события ложатся в него заметками
  const ids: string[] = [];
  for (let i = 1; i <= 3; i++) ids.push((await api.call(ticketNew, { project: PROJECT, on: FOUND, text: `событие по имени ${tag} · ${i}` })).id);
  const t = (await api.call(ticketList, { ticket: found })).tickets[0]!;
  const mine = t.notes!.filter((n) => n.text.includes(`событие по имени ${tag}`)).length;
  if (ids.some((id) => id !== found) || mine !== 3 || (await byRule(FOUND)).length !== 1) throw new Error(`события ушли не туда: ${ids.join(", ")}; заметок с событием ${mine}, тикетов правила ${(await byRule(FOUND)).length}`);
  return `три события — тикет ${found}, заметок ${was} → ${t.notes!.length}, тикетов правила 1`;
});
await step("пауза: правила входа не срабатывают — срок тихого правила идёт, тикетов и заметок не прибавилось", async () => {
  await api.call(factoryPause, { project: PROJECT, on: true });
  const notes = async () => (found ? (await api.call(ticketList, { ticket: found })).tickets[0]!.notes!.length : 0);
  // срабатывание, которое уже шло в момент паузы, дописывает свою заметку
  await sleep(3000);
  const was = await notes();
  const due = (await api.call(factoryGet, { project: PROJECT })).factory!.next[QUIET]!;
  await sleep(Math.max(0, due - Date.now()) + RULE_EVERY_S * 1000 + 3000);
  const now = await notes();
  const moved = (await api.call(factoryGet, { project: PROJECT })).factory!.next[QUIET]! > due;
  const made = (await byRule(FOUND)).length + (await byRule(QUIET)).length;
  if (!moved || now !== was || made !== (found ? 1 : 0)) throw new Error(`на паузе: срок ушёл вперёд — ${moved}, заметок ${was} → ${now}, тикетов правил ${made}`);
  return `заметок ${was} → ${now}, тикетов правил ${made}`;
});
if (!lacks("clickhouse"))
  await step(`история флота: строк «rule» тихого правила — не меньше ${QUIET_RUNS}, все «тихо» до паузы; у правила с находкой — один «тикет» и заметки`, async () => {
    type Line = { at: number; kind?: string; data?: unknown };
    const of = (lines: Line[], rule: string) => lines.filter((l) => l.at >= started && (l.data as { rule?: string; project?: string } | undefined)?.rule === rule && (l.data as { project?: string }).project === PROJECT);
    let lines: Line[] = [];
    for (let i = 0; i < 20; i++) {
      lines = (await api.call(logQuery, { msg: "rule", limit: 1000 })).lines;
      if (of(lines, QUIET).filter((l) => l.kind === "quiet").length >= QUIET_RUNS && of(lines, QUIET).some((l) => l.kind === "paused")) break;
      await sleep(2000);
    }
    const q = of(lines, QUIET), f = of(lines, FOUND);
    const count = (ls: Line[], kind: string) => ls.filter((l) => l.kind === kind).length;
    const odd = q.filter((l) => l.kind !== "quiet" && l.kind !== "paused");
    if (count(q, "quiet") < QUIET_RUNS || odd.length || !count(q, "paused")) throw new Error(`тихое правило: «тихо» ${count(q, "quiet")}, «пауза» ${count(q, "paused")}, прочих ${odd.length} (${odd.map((l) => l.kind).join(", ")})`);
    if (q.some((l) => l.kind === "quiet" && (l.data as { code?: number }).code !== 0)) throw new Error("у строки «тихо» код проверки не 0");
    if (count(f, "ticket") !== 1 || count(f, "note") < NOTES) throw new Error(`правило с находкой: «тикет» ${count(f, "ticket")}, «заметка» ${count(f, "note")}`);
    // вход по адресу: строка «hook» с ответом 202 и путём без секрета
    const hooks = (await api.call(logQuery, { msg: "hook", limit: 200 })).lines.filter((l) => l.at >= started && (l.data as { rule?: string }).rule === DOOR);
    const paths = hooks.map((l) => String((l.data as { path?: string }).path));
    if (!hooks.some((l) => (l.data as { status?: number }).status === 202) || (secret && paths.some((p) => p.includes(secret)))) throw new Error(`строки входа: ${JSON.stringify(hooks.map((l) => l.data))}`);
    return `тихое правило: «тихо» ${count(q, "quiet")}, «пауза» ${count(q, "paused")}; находка: «тикет» 1, «заметка» ${count(f, "note")}; вход по адресу: строк ${hooks.length}, путь без секрета`;
  });
await step("тикет находки снят, пост-сторож убран", async () => {
  if (found) await api.call(ticketSet, { ticket: found, drop: true, note: "живая проверка кончена" });
  const post = ((await api.call(fleetList, {})).sessions as { callsign: string }[]).map((x) => x.callsign).find((c) => c.startsWith(POST + "@"));
  if (post) await api.call(sessionRemove, { to: post });
  return post ? `сессия ${post} убрана` : "сессии поста нет";
});
await step("тикеты закрыты — свежие сессии шагов убраны", async () => {
  const mine = (n: string) => ids.some((id) => n.startsWith(id + "-s"));
  let left: string[] = [];
  for (let i = 0; i < 20; i++) {
    left = ((await api.call(fleetList, {})).sessions as { callsign: string }[]).map((s) => s.callsign).filter(mine);
    if (!left.length) break;
    await sleep(2000);
  }
  if (left.length) throw new Error(`остались сессии шагов: ${left.join(", ")}`);
  return `сессий шагов осталось 0 из ${TICKETS * 2}`;
});
process.exit(bad ? 1 : 0);
