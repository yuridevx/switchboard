// Живая проверка конвейера во флоте в коробке: node tools/fleet/live-lines.ts [флот] [устройство]
// Определение проекта коробки лежит в её репозитории кусочков (tools/box/factory.mjs): конвейер из трёх шагов с потолком два.
// Проверка применяет определение, кладёт на конвейер пять тикетов и ждёт, пока все пройдут три шага: свежая сессия → та же → свежая.
// Одновременно в работе — не больше потолка: это видно по загрузке конвейера во время прогона и по истории флота после него.
import fs from "node:fs";
import path from "node:path";
import { CallError, createApi, factoryApply, factoryGet, fleetList, httpTransport, logQuery, ticketList, ticketNew } from "@sb/protocol";
import { LINE, PROJECT } from "../box/factory.mjs";
import { REPO } from "../box/github.mjs";
import { dev, fleetEnv } from "../dev.mjs";
import { lacks, newTag } from "./harness.mjs";

const [fleet = "box", device = "cli"] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dev, `v2-${fleet}-${device}.pass`), "utf8").trim();
const wire = httpTransport({ base: fleetEnv.SB2_BASE!, key });
const api = createApi({ ...wire, call: async (f) => { for (let i = 0; ; i++) { const r = await wire.call(f); if (r.ok || r.error !== "offline" || i >= 4) return r; await new Promise((x) => setTimeout(x, 3000)); } } });
const tag = newTag();
const TICKETS = 5, LIMIT = 2, STEPS = 3;

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
  return `коммит ${r.commit.slice(0, 7)}, конвейер «${line.title}»: шагов ${line.steps.length}, потолок ${line.limit}`;
});
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
