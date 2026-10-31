// Точка входа Host. Запускает keeper: первая строка ввода — { keeper, key } (адрес и ключ — не в аргументах и не в файле).
// Конфиг — ~/.switchboard/host.json (папка — SWITCHBOARD_HOME), ключ машины для relay — файл из host.json или SWITCHBOARD_KEY.
// node main.ts --check — гейт выпуска отдельным процессом, без relay, keeper, хранилища и claude.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { PROTO } from "@switchboard/relay";
import type { Manifest } from "./contract.ts";
import { Kernel, StartError } from "./src/kernel.ts";
import type { HostConfig, SdkApi } from "./src/kernel.ts";
import { parseKeeperLine } from "./src/keeper.ts";
import { gate } from "./src/registry.ts";
import { claudePath, loadRelease } from "./src/release.ts";

const coreDir = dirname(fileURLToPath(import.meta.url));
const core = JSON.parse(readFileSync(join(coreDir, "module.json"), "utf8")) as Manifest;
const home = process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard");
const tilde = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Первая строка ввода. */
function firstLine(): Promise<string> {
  return new Promise((res, rej) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        process.stdin.pause();
        res(buf.slice(0, i));
      }
    });
    process.stdin.on("end", () => (buf ? res(buf) : rej(new Error("ввод закрыт без строки keeper"))));
  });
}

async function check(): Promise<number> {
  try {
    const rel = await loadRelease(coreDir);
    const errors = gate(core, rel.modules, true);
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

function cli(bin: string | undefined): SdkApi["cli"] {
  return (args, env, input) =>
    new Promise((res) => {
      if (!bin) return res({ code: null, out: "claude не найден в пакете SDK" });
      const p = spawn(bin, args, { env, windowsHide: true });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("error", (e) => res({ code: null, out: e.message }));
      p.on("close", (code) => res({ code, out }));
      p.stdin.end(input ?? "");
    });
}

async function main(): Promise<number> {
  if (process.argv.includes("--check")) return check();
  const keeper = parseKeeperLine(await firstLine());
  const config = JSON.parse(readFileSync(join(home, "host.json"), "utf8")) as HostConfig;
  const relay = config.workers?.relay;
  const relayKey = process.env.SWITCHBOARD_KEY ?? (relay?.key ? readFileSync(tilde(relay.key), "utf8").trim() : undefined);
  const release = await loadRelease(coreDir);
  const functions: SdkApi["functions"] = {};
  for (const [n, f] of Object.entries(sdk)) if (typeof f === "function") functions[n] = f as (...a: unknown[]) => Promise<unknown>;
  const k = new Kernel({
    home,
    config,
    core,
    release,
    sdk: { query: sdk.query, functions, cli: cli(claudePath(coreDir)) },
    keeper,
    relayKey,
    loadRelease,
    exit: (code) => process.exit(code),
  });
  // сигнал ОС — как обновление: процессы claude остаются у keeper
  process.on("SIGTERM", () => void k.shutdown("upgrade"));
  process.on("SIGINT", () => void k.shutdown("upgrade"));
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
