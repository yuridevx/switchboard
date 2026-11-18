// Живая проверка «выкладка сборки»: node tools/fleet/live-roll.mjs [флот] [устройство] [машина] [вторая машина]
// Тем же шагом, которым выкладывает CI (tools/deploy/machines.mjs): новая сборка уходит в каталог флота, служба каждой машины
// скачивает её, сверяет, ставит и подменяет Host — сессии на месте; служба машины из новой сборки подменяет и саму себя.
// Идёт только на флоте в коробке и одна: подменяет Host на всех машинах флота. На живой флот сборку доводит CI, проверка её туда не несёт.
import { rollLine, rollMachines } from "../deploy/machines.mjs";
import { fleetCall, local, machineTmp, newTag } from "./harness.mjs";
import { say, turn } from "./turn.mjs";

const [fleet = "test", device = "cli", ...machines] = process.argv.slice(2);
if (!local()) throw new Error("выкладка сборки проверяется только на флоте в коробке: на живой флот сборку доводит CI");
const { call, must } = fleetCall(fleet, device);
const tag = newTag();
const SEAT = process.env.SB2_KEY ?? "muse";
const MODEL = process.env.SB2_MODEL ?? must("keys.models", { name: SEAT }).models[0].id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0, total = 0;
async function step(label, fn) {
  total++;
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${String(e.message).split("\n")[0]}`);
  }
}
const rowOf = (cs) => must("fleet.list", { machine: cs.split("@")[1], full: true }).sessions.find((s) => s.callsign === cs);
/** Сессия ответила этим словом: свободна и слово в итоге хода. */
async function answered(cs, word) {
  for (const end = Date.now() + 120_000; ; await sleep(1500)) {
    const r = rowOf(cs);
    if (r?.state === "failed") throw new Error(`${cs}: сбой — ${r.error}`);
    if (r?.state === "idle" && String(r.result ?? "").includes(word)) return;
    if (Date.now() > end) throw new Error(`${cs} не ответила «${word}» за 120 с: ${r?.state} · ${String(r?.result ?? "").slice(0, 60)}`);
  }
}

const made = [];
let was = 0;
await step("сессии открыты на каждой машине и ответили", async () => {
  was = must("builds.list", {}).stable;
  for (const m of machines) made.push(must("session.open", { to: "@" + m, spec: { name: `roll-${tag}`, cwd: `${machineTmp(fleet, device, m)}/sb2-roll-${tag}`, key: SEAT, model: MODEL }, mkdir: true, prompt: turn(say("до")) }).callsign);
  for (const cs of made) await answered(cs, "до");
  return `${made.join(", ")}; на флоте сборка ${was}`;
});

let build = 0;
await step("новая сборка дошла до машин шагом выкладки: Host подменён, сессии на месте", async () => {
  const r = await rollMachines(fleet, device);
  build = r.build;
  if (r.build <= was) throw new Error(`номер сборки не вырос: ${was} → ${r.build}`);
  if (r.lost.length || r.failed.length) throw new Error(`пропало: ${r.lost.join(", ") || "—"}; упало: ${r.failed.join(", ") || "—"}`);
  if (made.some((cs) => !rowOf(cs))) throw new Error("своей сессии нет в картине");
  return rollLine(r);
});

await step("служба каждой машины — из новой сборки: подменила себя и держит новый Host", async () => {
  const seen = [];
  for (const m of machines) {
    // после подмены себя служба поднимается снова: её ответ ждём
    let k;
    for (const end = Date.now() + 60_000; ; await sleep(1500)) {
      k = call("keeper.state", { to: `.keeper@${m}` }).result;
      if (k?.build === build && k.host.build === build && k.host.state === "running") break;
      if (Date.now() > end) throw new Error(`${m}: служба машины сборки ${k?.build}, Host сборки ${k?.host?.build} (${k?.host?.state}); ждали ${build}`);
    }
    seen.push(`${m}: служба ${k.build}, Host ${k.host.build}`);
  }
  return seen.join("; ");
});

await step("сессии после подмены отвечают на новый ход", async () => {
  for (const cs of made) must("message", { to: cs, text: turn(say("после")) });
  for (const cs of made) await answered(cs, "после");
  return `ответили ${made.length} из ${made.length}`;
});

for (const cs of made) call("session.remove", { to: cs });
console.log(bad ? `сбоев: ${bad} из ${total}` : `выкладка сборки: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
