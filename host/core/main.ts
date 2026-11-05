// Точка входа Host — часть машины, её запускает keeper. Ввод закрылся или сигнал ОС — штатный выход,
// процессы claude остаются у своих держателей. От keeper — окружение: SWITCHBOARD_MACHINE, SWITCHBOARD_HOLDER (файл
// держателя), SWITCHBOARD_HOME; адреса relay и Worker'ов флота — в списке сборки (build.json). Ключ машины — ~/.switchboard/machine.key;
// разделы модулей — ~/.switchboard/host.json { "modules": {…} }, файла нет — модули без настроек.
// node main.ts --check — гейт выпуска отдельным процессом, без relay, keeper, хранилища и claude.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { PROTO } from "@switchboard/relay";
import type { Manifest } from "./contract.ts";
import { realHolders } from "./src/holders.ts";
import { Kernel, StartError } from "./src/kernel.ts";
import type { SdkApi } from "./src/kernel.ts";
import { gate } from "./src/registry.ts";
import { claudeCli, claudePath, loadRelease } from "./src/release.ts";

const coreDir = dirname(fileURLToPath(import.meta.url));
const core = JSON.parse(readFileSync(join(coreDir, "module.json"), "utf8")) as Manifest;
const home = process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard");

/** Гейт выпуска: ответ одной строкой JSON, код 0 или 1. */
async function check(): Promise<number> {
  try {
    const release = await loadRelease(coreDir);
    const { fatal, down } = gate(core, release.modules, true);
    const errors = [...fatal, ...[...down.values()].flat()];
    if (errors.length) {
      console.log(JSON.stringify({ ok: false, why: errors.join("; ") }));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, version: release.version, sdk: release.sdk, proto: PROTO }));
    return 0;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, why: (e as Error).message }));
    return 1;
  }
}

/** Код выхода; null — Host работает, выход сделает остановка. */
async function run(): Promise<number | null> {
  if (process.argv.includes("--check")) return check();
  const machine = process.env.SWITCHBOARD_MACHINE;
  if (!machine) {
    console.error("host: нет SWITCHBOARD_MACHINE — Host запускает keeper");
    return 1;
  }
  const hostFile = join(home, "host.json");
  const modules = existsSync(hostFile) ? (JSON.parse(readFileSync(hostFile, "utf8")) as { modules?: Record<string, unknown> }).modules : undefined;
  const keyFile = join(home, "machine.key");
  // claude ищет Host один раз; SDK без пути ищет сам через process.report — на Linux с открытыми сокетами это ~20 с
  const bin = claudePath(coreDir);
  const functions: SdkApi["functions"] = {};
  for (const [n, f] of Object.entries(sdk)) if (typeof f === "function") functions[n] = f as (...a: unknown[]) => Promise<unknown>;
  const kernel = new Kernel({
    home,
    config: { machine, modules },
    core,
    release: await loadRelease(coreDir),
    sdk: { query: sdk.query, functions, cli: claudeCli(bin), bin },
    holders: realHolders(home, process.env.SWITCHBOARD_HOLDER),
    relayKey: existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined,
    exit: (code) => process.exit(code),
  });
  // ввод закрыт или сигнал ОС — штатный выход: процессы claude остаются у своих держателей
  process.stdin.on("end", () => void kernel.shutdown("ввод закрыт"));
  process.stdin.on("error", () => void kernel.shutdown("ввод закрыт"));
  process.stdin.resume();
  process.on("SIGTERM", () => void kernel.shutdown("SIGTERM"));
  process.on("SIGINT", () => void kernel.shutdown("SIGINT"));
  // ошибка в работе модуля вне вызова ядра — модуль выключен, Host живёт; чья — неизвестно: выход 1, чистый перезапуск
  const stray = (e: unknown) => {
    if (kernel.stray(e)) return;
    console.error(e);
    process.exit(1);
  };
  process.on("unhandledRejection", stray);
  process.on("uncaughtException", stray);
  try {
    await kernel.start();
  } catch (e) {
    console.error(e instanceof StartError ? `host: не стартует\n${e.message}` : "host:", ...(e instanceof StartError ? [] : [e]));
    return 1;
  }
  return null;
}

run().then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (e) => {
    console.error("host:", e);
    process.exit(1);
  },
);
