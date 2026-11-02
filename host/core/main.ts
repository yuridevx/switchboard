// Точка входа Host — часть машины, её запускает keeper. Ввод закрылся или сигнал ОС — штатный выход,
// процессы claude остаются у своих держателей. От keeper — окружение: SWITCHBOARD_MACHINE, SWITCHBOARD_RELAY, SWITCHBOARD_WORKERS,
// SWITCHBOARD_HOLDER (файл держателя), SWITCHBOARD_HOME. Ключ машины — ~/.switchboard/machine.key;
// разделы модулей — ~/.switchboard/host.json { "modules": {…} }, файла нет — модули без настроек.
// node main.ts --check — гейт выпуска отдельным процессом, без relay, keeper, хранилища и claude.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { PROTO } from "@switchboard/relay";
import type { Manifest } from "./contract.ts";
import { Kernel, StartError } from "./src/kernel.ts";
import type { HostConfig, SdkApi } from "./src/kernel.ts";
import { realHolders } from "./src/holders.ts";
import { gate } from "./src/registry.ts";
import { claudeCli, claudePath, loadRelease } from "./src/release.ts";

const coreDir = dirname(fileURLToPath(import.meta.url));
const core = JSON.parse(readFileSync(join(coreDir, "module.json"), "utf8")) as Manifest;
const home = process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard");

async function check(): Promise<number> {
  try {
    const rel = await loadRelease(coreDir);
    const g = gate(core, rel.modules, true);
    const errors = [...g.fatal, ...[...g.down.values()].flat()];
    if (errors.length) {
      console.log(JSON.stringify({ ok: false, why: errors.join("; ") }));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, version: rel.version, sdk: rel.sdk, proto: PROTO }));
    return 0;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, why: (e as Error).message }));
    return 1;
  }
}

async function main(): Promise<number> {
  if (process.argv.includes("--check")) return check();
  const machine = process.env.SWITCHBOARD_MACHINE;
  if (!machine) {
    console.error("host: нет SWITCHBOARD_MACHINE — Host запускает keeper");
    return 1;
  }
  const file = join(home, "host.json");
  const modules = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { modules?: Record<string, unknown> }).modules : undefined;
  const workers = process.env.SWITCHBOARD_WORKERS ? (JSON.parse(process.env.SWITCHBOARD_WORKERS) as Record<string, string>) : undefined;
  const config: HostConfig = { machine, relay: process.env.SWITCHBOARD_RELAY, workers, modules };
  const keyFile = join(home, "machine.key");
  const relayKey = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined;
  const release = await loadRelease(coreDir);
  // claude ищет Host один раз; SDK без пути ищет сам через process.report — на Linux с открытыми сокетами это ~20 с
  const bin = claudePath(coreDir);
  const functions: SdkApi["functions"] = {};
  for (const [n, f] of Object.entries(sdk)) if (typeof f === "function") functions[n] = f as (...a: unknown[]) => Promise<unknown>;
  const k = new Kernel({
    home,
    config,
    core,
    release,
    sdk: { query: sdk.query, functions, cli: claudeCli(bin), bin },
    holders: realHolders(home, process.env.SWITCHBOARD_HOLDER),
    relayKey,
    exit: (code) => process.exit(code),
  });
  // ввод закрыт или сигнал ОС — штатный выход: процессы claude остаются у своих держателей
  process.stdin.on("end", () => void k.shutdown("ввод закрыт"));
  process.stdin.on("error", () => void k.shutdown("ввод закрыт"));
  process.stdin.resume();
  process.on("SIGTERM", () => void k.shutdown("SIGTERM"));
  process.on("SIGINT", () => void k.shutdown("SIGINT"));
  // ошибка в работе модуля вне вызова ядра — модуль выключен, Host живёт; чья — неизвестно: выход 1, чистый перезапуск
  const stray = (e: unknown) => {
    if (k.stray(e)) return;
    console.error(e);
    process.exit(1);
  };
  process.on("unhandledRejection", stray);
  process.on("uncaughtException", stray);
  try {
    await k.start();
  } catch (e) {
    if (e instanceof StartError) console.error(`host: не стартует\n${e.message}`);
    else console.error("host:", e);
    return 1;
  }
  return -1;
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error("host:", e);
    process.exit(1);
  },
);
