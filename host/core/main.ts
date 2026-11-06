// Процесс Host: окружение от keeper, сборка рядом с packages/, ловушка процесса, сигналы и закрытый ввод — штатная остановка.
//   --check — гейт выпуска: одна строка JSON, код 0 или 1.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { PROTO } from "@switchboard/relay";
import { setProblems } from "./src/gate.ts";
import { realHolders } from "./src/holders.ts";
import { Kernel, StartError } from "./src/kernel.ts";
import { claudeCli, claudePath, loadRelease } from "./src/release.ts";

const dir = import.meta.dirname;
const root = join(dir, "..", "..");
const core = JSON.parse(readFileSync(join(dir, "module.json"), "utf8"));
const json = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});

let kernel: Kernel | undefined;
const trap = (e: unknown) => {
  if (kernel?.stray(e)) return;
  console.error(e);
  process.exit(1);
};
process.on("uncaughtException", trap);
process.on("unhandledRejection", trap);

/** Гейт выпуска: сборка загружается и набор годен. */
async function check(): Promise<number> {
  try {
    const release = await loadRelease(root, dir);
    const why = setProblems(core, release.modules, release.workers).join("; ");
    console.log(JSON.stringify(why ? { ok: false, why } : { ok: true, version: release.version, sdk: release.sdk, proto: PROTO }));
    return why ? 1 : 0;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, why: String(e) }));
    return 1;
  }
}

async function main(): Promise<void> {
  const machine = process.env.SWITCHBOARD_MACHINE;
  if (!machine) throw new Error("нет SWITCHBOARD_MACHINE — Host запускает keeper");
  const home = process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard");
  const keyFile = join(home, "machine.key");
  const bin = claudePath(dir);
  const functions = Object.fromEntries(Object.entries(sdk).filter(([, f]) => typeof f === "function")) as never;
  kernel = new Kernel({
    home,
    config: { ...json(join(home, "host.json")), machine },
    core,
    release: await loadRelease(root, dir),
    sdk: { query: sdk.query as never, functions, cli: claudeCli(bin), bin },
    holders: realHolders(home, process.env.SWITCHBOARD_HOLDER),
    relayKey: existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined,
    exit: (code) => process.exit(code),
  });
  const stop = (why: string) => void kernel!.shutdown(why);
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.stdin.on("end", () => stop("ввод закрыт"));
  process.stdin.resume();
  await kernel.start();
}

if (process.argv.includes("--check")) process.exit(await check());
await main().catch((e: unknown) => {
  console.error(`host: ${e instanceof StartError ? `не стартует: ${e.message}` : e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
