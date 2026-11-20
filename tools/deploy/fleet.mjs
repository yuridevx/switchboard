// Выкладка на флот одной командой: node tools/deploy/fleet.mjs <флот> [устройство] [--plan]
// Запускает CI: на флот идёт только отсюда, по одной выкладке на флот (очередь держит GitHub). SB2_ENV=prod — прод.
// Собирает страницу, считает отпечатки трёх частей дерева, спрашивает флот об отпечатках того, что стоит, и выкладывает
// только несовпавшее, в порядке: платформа, службы со страницей, машины. Повторный запуск доводит оборванную выкладку.
// --plan — только назвать, что было бы выложено. Отказ любого шага — выход с кодом 1 и причиной; уже выложенное остаётся.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digests } from "../build/digest.mjs";
import { buildPage } from "../build/page.mjs";
import { fleetEnv } from "../dev.mjs";
import { exec, fleetMust, rollLine, rollMachines } from "./machines.mjs";
import { plan } from "./plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [fleet, device = "ci"] = args;
if (!fleet) throw new Error("нужно: <флот> [устройство] [--plan]");
const only = process.argv.includes("--plan");
const prod = process.env.SB2_ENV === "prod";
const base = fleetEnv.SB2_BASE;
const STEP_MS = 15 * 60_000; // предел одной команды выкладки

const sh = async (cmd, cmdArgs, opts = {}) => {
  const r = await exec(cmd, cmdArgs, { cwd: root, timeout: STEP_MS, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.slice(0, 3).join(" ")}: ${r.status === null ? "предел вышел" : "код " + r.status}`);
  return r;
};
const node = (file, fileArgs, opts) => sh(process.execPath, [path.join(root, file), ...fileArgs], opts);
// запрос флоту пропуском устройства — общий вход инструментов: результат или отказ словом
const call = fleetMust(fleet, device);
// до первой выкладки отсюда служба об отпечатке не отвечает: ответа-JSON нет — отпечатка нет, часть выкладывается
const health = async (p) => (await (await fetch(base + p, { signal: AbortSignal.timeout(30_000) })).json().catch(() => ({}))).digest;
/** Версия Worker'а, которая стоит сейчас: номер для отката. */
const version = async (part) => {
  const r = await exec(process.execPath, [path.join(here, "wrangler.mjs"), part, "deployments", "status", "--json", ...(prod ? ["--env", "prod"] : [])], { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: STEP_MS });
  return /"version_id":\s*"([^"]+)"/.exec(r.stdout ?? "")?.[1] ?? "нет";
};

// страница — часть служб: её отдаёт тот же Worker, поэтому собирается до отпечатков; режим комментариев к странице — только на тестовом флоте
buildPage(root, { prod });
const tree = await digests(root);
const catalog = await call("builds.list");
const stands = { platform: await health("/health/platform"), services: await health("/health"), machines: catalog.builds.find((b) => b.build === catalog.stable)?.digest };
const todo = plan(tree, stands);
const short = (d) => (d ?? "нет").slice(0, 12);
for (const part of Object.keys(tree)) console.log(`${todo.includes(part) ? "→" : "="} ${part}: в дереве ${short(tree[part])}, на флоте ${short(stands[part])}`);
if (only || !todo.length) {
  console.log(todo.length ? `было бы выложено: ${todo.join(", ")}` : "выкладывать нечего: на флоте то же, что в дереве");
  process.exit(0);
}

const done = [];
for (const part of todo) {
  if (part === "machines") {
    const r = await rollMachines(fleet, device);
    done.push(rollLine(r));
    if (r.lost.length || r.failed.length) throw new Error(`после подмены Host: пропало сессий ${r.lost.length}, новых сбоев ${r.failed.length}`);
  } else {
    const back = await version(part);
    await node("tools/deploy/wrangler.mjs", [part, "deploy", "--var", `DIGEST:${tree[part]}`, ...(prod ? ["--env", "prod"] : [])]);
    done.push(`${part} — версия ${await version(part)} (откат ${back})`);
  }
  console.log("✓ " + done.at(-1));
}
const total = `флот ${fleet}: выложено ${done.length} из 3 частей`;
console.log(total);
// итог прогона CI: что выложено и номера для отката
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Выкладка · флот ${fleet}\n\n${done.map((d) => "- " + d).join("\n")}\n\n`);
