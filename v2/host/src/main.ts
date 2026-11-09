// Процесс Host. Всё о машине — из окружения, его ставит Keeper (для запуска руками — те же переменные):
//   SB_HOME — папка флота (~/.switchboard2/<флот>): в ней machine.key и procs/ держателей; SB_DATA — папка данных Host (по умолчанию <SB_HOME>/host/data);
//   SB_FLEET, SB_MACHINE, SB_BASE — флот, имя машины, адрес флота; SB_BUILD — номер сборки; SB_HOLDER — файл keeper для `keeper hold`.
// Ловушка процесса, сигналы и закрытый ввод — штатная остановка. --check — проверка набора: одна строка JSON, код 0 или 1.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { parsePass, PROTO } from "@sb/protocol";
import { claudeCli, claudePath, sdkVersion } from "./core/claude.ts";
import { realHolders } from "./core/holders.ts";
import { Kernel, StartError } from "./core/kernel.ts";
import { modules } from "./modules/index.ts";

let kernel: Kernel | undefined;
const trap = (e: unknown) => {
  // ошибка вне запроса: строка журнала, Host работает дальше — чинит агент по журналу
  if (kernel) return void kernel.log.error("uncaught", { word: "module_failed", why: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  console.error(e);
  process.exit(1);
};
process.on("uncaughtException", trap);
process.on("unhandledRejection", trap);
// раньше обработчика SDK: на выходе он закрывает ввод своим процессам, а процессы сессий живут дальше
process.on("exit", () => kernel?.holders.close());

function options() {
  const env = process.env;
  const home = env.SB_HOME;
  const machine = env.SB_MACHINE;
  const base = env.SB_BASE;
  if (!home || !machine || !base) throw new Error("нет SB_HOME, SB_MACHINE или SB_BASE — Host запускает Keeper");
  const keyFile = join(home, "machine.key");
  const key = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "";
  const fleet = env.SB_FLEET ?? parsePass(key)?.fleet;
  if (!fleet) throw new Error(`нет SB_FLEET и пропуска машины в ${keyFile}`);
  const data = env.SB_DATA ?? join(home, "host", "data");
  const config = existsSync(join(data, "host.json")) ? (JSON.parse(readFileSync(join(data, "host.json"), "utf8")) as Record<string, unknown>) : {};
  const bin = claudePath();
  const functions = Object.fromEntries(Object.entries(sdk).filter(([, f]) => typeof f === "function")) as never;
  return {
    home: data, machine, fleet, base: base.replace(/\/+$/, ""), key, build: Number(env.SB_BUILD ?? 0), sdkVersion: sdkVersion(), modules: modules(), config,
    sdk: { query: sdk.query as never, functions, cli: claudeCli(bin), bin },
    // держатель берёт папку флота только из SB_HOME: файлы procs/ лежат в ней
    holders: realHolders(home, env.SB_HOLDER),
    exit: (code: number) => process.exit(code),
  };
}

async function main(): Promise<void> {
  kernel = new Kernel(options());
  const stop = (why: string) => void kernel!.shutdown(why);
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.stdin.on("end", () => stop("ввод закрыт"));
  process.stdin.on("error", () => stop("ввод закрыт"));
  process.stdin.resume();
  await kernel.start();
}

if (process.argv.includes("--check")) {
  // набор модулей годен: у имён по одному хозяину, запросы есть в договоре
  try {
    const why = new Kernel({ home: join(process.env.SB_DATA ?? process.cwd(), ".check"), machine: "check", fleet: "check", base: "https://check", key: "", build: 0, sdkVersion: sdkVersion(), modules: modules(), sdk: { query: () => ({}), functions: {}, cli: async () => ({ code: 0, out: "" }) }, holders: { spawn: () => Promise.reject(new Error("check")), files: () => [] } }).check();
    console.log(JSON.stringify(why.length ? { ok: false, why: why.join("; ") } : { ok: true, sdk: sdkVersion(), proto: PROTO }));
    process.exit(why.length ? 1 : 0);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, why: String(e) }));
    process.exit(1);
  }
}
await main().catch((e: unknown) => {
  console.error(`host: ${e instanceof StartError ? `не стартует: ${e.message}` : e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
