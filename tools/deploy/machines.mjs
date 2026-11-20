// Шаг «машины» выкладки: сборка под следующим номером уходит в каталог флота и назначается ему; машины на связи встают на неё, сессии остаются.
// Хозяин шага один: его зовут выкладка (tools/deploy/fleet.mjs), подъём флота в коробке (tools/box/box.mjs) и живая проверка «выкладка сборки».
//   node tools/deploy/machines.mjs <флот> [устройство]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { httpTransport, newId } from "@sb/protocol";
import { dev, fleetEnv } from "../dev.mjs";
import { nextBuild } from "./plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILD_MS = 15 * 60_000; // предел сборки и загрузки
const ROLL_MS = 10 * 60_000; // предел ожидания, пока машины встанут на новую сборку
const BACK_MS = 3 * 60_000; // предел ожидания, пока сессии вернутся после подмены Host
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Запрос флоту пропуском устройства из настроек разработки: результат или отказ словом. */
export function fleetMust(fleet, device) {
  const key = fs.readFileSync(path.join(dev, `v2-${fleet}-${device}.pass`), "utf8").trim();
  const transport = httpTransport({ base: fleetEnv.SB2_BASE, key });
  return async (type, fields = {}) => {
    const r = await transport.call({ ...fields, type, id: newId("r"), trace: newId("t") });
    if (!r.ok) throw new Error(`${type}: ${r.error} ${r.why ?? ""}`);
    return r.result;
  };
}

/** Довести новую сборку до машин флота. Итог: номер сборки и номер отката; сколько сессий было, какие пропали и какие упали.
 *  Сборка не собралась или машины не встали на неё за предел — ошибка; судьбу сессий решает тот, кто звал. */
export async function rollMachines(fleet, device = "ci") {
  const call = fleetMust(fleet, device);
  const catalog = await call("builds.list");
  const build = nextBuild(catalog.builds);
  // сессии до подмены Host: после неё каждая должна быть на месте, новых сбоев — 0
  const was = new Map((await call("fleet.list")).sessions.map((s) => [s.callsign, s.state]));
  const built = spawnSync(process.execPath, [path.join(root, "tools/build/build.mjs"), String(build), "--upload", fleet, device], { cwd: root, stdio: "inherit", timeout: BUILD_MS });
  if (built.status !== 0) throw new Error(`сборка ${build}: ${built.status === null ? "предел вышел" : "код " + built.status}`);
  await call("builds.deploy", { build });
  // сборка назначена флоту; машины на связи должны на неё встать
  for (const end = Date.now() + ROLL_MS; ; await sleep(2000)) {
    const late = (await call("fleet.list")).machines.filter((m) => m.online && m.build !== build).map((m) => m.name);
    if (!late.length) break;
    if (Date.now() > end) throw new Error(`машины не встали на сборку ${build} за ${ROLL_MS / 60_000} мин: ${late.join(", ")}`);
  }
  let lost = [], failed = [];
  for (const end = Date.now() + BACK_MS; ; await sleep(2000)) {
    const now = new Map((await call("fleet.list")).sessions.map((s) => [s.callsign, s.state]));
    lost = [...was.keys()].filter((c) => !now.has(c));
    failed = [...was.keys()].filter((c) => now.get(c) === "failed" && was.get(c) !== "failed");
    if (!lost.length || Date.now() > end) break;
  }
  return { build, back: catalog.stable, was: was.size, lost, failed };
}

/** Итог шага одной строкой. */
export const rollLine = (r) => `машины — сборка ${r.build} (откат ${r.back ?? "нет"}); сессий до ${r.was}, пропало ${r.lost.length}, новых сбоев ${r.failed.length}`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [fleet, device] = process.argv.slice(2);
  if (!fleet) throw new Error("нужно: <флот> [устройство]");
  const r = await rollMachines(fleet, device);
  console.log((r.lost.length || r.failed.length ? "✗ " : "✓ ") + rollLine(r));
  process.exit(r.lost.length || r.failed.length ? 1 : 0);
}
