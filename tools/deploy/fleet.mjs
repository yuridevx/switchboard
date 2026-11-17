// Выкладка на флот одной командой: node tools/deploy/fleet.mjs <флот> [устройство] [--plan]
// Запускает CI: на флот идёт только отсюда, по одной выкладке на флот (очередь держит GitHub). SB2_ENV=prod — прод.
// Собирает страницу, считает отпечатки трёх частей дерева, спрашивает флот об отпечатках того, что стоит, и выкладывает
// только несовпавшее, в порядке: платформа, службы со страницей, машины. Повторный запуск доводит оборванную выкладку.
// --plan — только назвать, что было бы выложено. Отказ любого шага — выход с кодом 1 и причиной; уже выложенное остаётся.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digests } from "../build/digest.mjs";
import { dev, fleetEnv } from "../dev.mjs";
import { nextBuild, plan } from "./plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [fleet, device = "ci"] = args;
if (!fleet) throw new Error("нужно: <флот> [устройство] [--plan]");
const only = process.argv.includes("--plan");
const prod = process.env.SB2_ENV === "prod";
const base = fleetEnv.SB2_BASE;
const key = fs.readFileSync(path.join(dev, `v2-${fleet}-${device}.pass`), "utf8").trim();
const ROLL_MS = 10 * 60_000; // предел ожидания, пока машины встанут на новую сборку
const BACK_MS = 3 * 60_000; // предел ожидания, пока сессии вернутся после подмены Host
const STEP_MS = 15 * 60_000; // предел одной команды выкладки

const sh = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", timeout: STEP_MS, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.slice(0, 3).join(" ")}: ${r.status === null ? "предел вышел" : "код " + r.status}`);
  return r;
};
const node = (file, fileArgs, opts) => sh(process.execPath, [path.join(root, file), ...fileArgs], opts);
async function call(type, fields = {}) {
  const res = await fetch(base + "/call", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ ...fields, type, id: "d" + Date.now().toString(36), trace: "td" + Date.now().toString(36) }), signal: AbortSignal.timeout(60_000) });
  const reply = await res.json();
  if (!reply.ok) throw new Error(`${type}: ${reply.error} ${reply.why ?? ""}`);
  return reply.result;
}
// до первой выкладки отсюда служба об отпечатке не отвечает: ответа-JSON нет — отпечатка нет, часть выкладывается
const health = async (p) => (await (await fetch(base + p, { signal: AbortSignal.timeout(30_000) })).json().catch(() => ({}))).digest;
/** Версия Worker'а, которая стоит сейчас: номер для отката. */
const version = (part) => {
  const r = spawnSync(process.execPath, [path.join(here, "wrangler.mjs"), part, "deployments", "status", "--json", ...(prod ? ["--env", "prod"] : [])], { cwd: root, encoding: "utf8", timeout: STEP_MS });
  return /"version_id":\s*"([^"]+)"/.exec(r.stdout ?? "")?.[1] ?? "нет";
};

// страница — часть служб: её отдаёт тот же Worker, поэтому собирается до отпечатков
sh("npx", ["vite", "build"], { cwd: path.join(root, "web"), shell: true, env: { ...process.env, VITE_FLEET: "origin" }, stdio: ["ignore", "ignore", "inherit"] });
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
    const build = nextBuild(catalog.builds);
    // сессии до подмены Host: после неё каждая должна быть на месте, новых сбоев — 0; в журнал идут только числа
    const before = (await call("fleet.list")).sessions;
    node("tools/build/build.mjs", [String(build), "--upload", fleet, device]);
    await call("builds.deploy", { build });
    // сборка назначена флоту; машины на связи должны на неё встать
    const end = Date.now() + ROLL_MS;
    for (;;) {
      const late = (await call("fleet.list")).machines.filter((m) => m.online && m.build !== build).map((m) => m.name);
      if (!late.length) break;
      if (Date.now() > end) throw new Error(`машины не встали на сборку ${build} за ${ROLL_MS / 60_000} мин: ${late.join(", ")}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    const was = new Map(before.map((s) => [s.callsign, s.state]));
    let lost = [], failed = [];
    for (const until = Date.now() + BACK_MS; ; await new Promise((r) => setTimeout(r, 5000))) {
      const now = new Map((await call("fleet.list")).sessions.map((s) => [s.callsign, s.state]));
      lost = [...was.keys()].filter((c) => !now.has(c));
      failed = [...was.keys()].filter((c) => now.get(c) === "failed" && was.get(c) !== "failed");
      if (!lost.length || Date.now() > until) break;
    }
    done.push(`машины — сборка ${build} (откат ${catalog.stable ?? "нет"}); сессий до ${was.size}, пропало ${lost.length}, новых сбоев ${failed.length}`);
    if (lost.length || failed.length) throw new Error(`после подмены Host: пропало сессий ${lost.length}, новых сбоев ${failed.length}`);
  } else {
    const back = version(part);
    node("tools/deploy/wrangler.mjs", [part, "deploy", "--var", `DIGEST:${tree[part]}`, ...(prod ? ["--env", "prod"] : [])]);
    done.push(`${part} — версия ${version(part)} (откат ${back})`);
  }
  console.log("✓ " + done.at(-1));
}
const total = `флот ${fleet}: выложено ${done.length} из 3 частей`;
console.log(total);
// итог прогона CI: что выложено и номера для отката
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Выкладка · флот ${fleet}\n\n${done.map((d) => "- " + d).join("\n")}\n\n`);
