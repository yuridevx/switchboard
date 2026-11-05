// Процесс Host. Его запускает keeper: SWITCHBOARD_MACHINE, SWITCHBOARD_HOLDER и папка данных (SWITCHBOARD_HOME или ~/.switchboard).
//   host.json     { modules: { <имя>: раздел host.config() } }
//   machine.key   пропуск машины
//   node main.ts --check — гейт выпуска: одна строка JSON, код 0 или 1.
// Остановка: SIGTERM, SIGINT или закрытый ввод (keeper меняет версию).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROTO } from "@switchboard/relay";
import type { Manifest } from "./contract.ts";
import { releaseProblems } from "./src/gate.ts";
import { realHolders } from "./src/holders.ts";
import { Kernel, StartError } from "./src/kernel.ts";
import { loadRelease, realSdk } from "./src/release.ts";

const coreDir = import.meta.dirname;

function die(text: string): never {
  console.error(text);
  process.exit(1);
}

async function check(core: Manifest): Promise<void> {
  try {
    const release = await loadRelease(coreDir);
    const problems = releaseProblems(core, release);
    console.log(JSON.stringify(problems.length ? { ok: false, why: problems.join("; ") } : { ok: true, version: release.version, sdk: release.sdk, proto: PROTO }));
    process.exitCode = problems.length ? 1 : 0;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, why: (e as Error).message }));
    process.exitCode = 1;
  }
  process.exit();
}

const core = JSON.parse(readFileSync(join(coreDir, "module.json"), "utf8")) as Manifest;
if (process.argv.includes("--check")) await check(core);

const machine = process.env.SWITCHBOARD_MACHINE;
if (!machine) die("host: нет SWITCHBOARD_MACHINE — Host запускает keeper");
const home = process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard");
const read = (name: string) => (existsSync(join(home, name)) ? readFileSync(join(home, name), "utf8") : undefined);

let kernel: Kernel | undefined;
function stray(e: unknown): void {
  if (kernel?.stray(e)) return;
  console.error(e);
  process.exit(1);
}
// ловушка раньше импорта модулей: их таймеры могут сработать ещё до старта
process.on("uncaughtException", stray);
process.on("unhandledRejection", stray);
// процессы остаются у держателей: соединения закрыты раньше, чем SDK на выходе из процесса тронет свои процессы
process.on("exit", () => kernel?.holders.close());

try {
  const release = await loadRelease(coreDir);
  const hostJson = read("host.json");
  kernel = new Kernel({
    home,
    config: { machine, ...(hostJson ? (JSON.parse(hostJson) as object) : {}) },
    core,
    release,
    sdk: realSdk(coreDir),
    holders: realHolders(home, process.env.SWITCHBOARD_HOLDER),
    relayKey: read("machine.key")?.trim(),
  });
  const stop = (why: string) => void kernel!.shutdown(why);
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.stdin.on("end", () => stop("ввод закрыт"));
  process.stdin.on("error", () => stop("ввод закрыт"));
  process.stdin.resume();
  await kernel.start();
} catch (e) {
  die(e instanceof StartError ? `host: не стартует: ${e.message}` : `host: ${(e as Error).message}`);
}
