// Папка модуля монорепо → архив: страницу и оболочку сначала собирает, остальное пакует как есть.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packModule, type PackedModule } from "@switchboard/release";

const BUILD_MS = 120_000;
const BUNDLE = join(import.meta.dirname, "bundle.ts");

const node = (args: string[], cwd?: string) => execFileSync(process.execPath, args, { cwd, timeout: BUILD_MS, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

export function packFromRepo(dir: string): PackedModule {
  const { type } = JSON.parse(readFileSync(join(dir, "module.json"), "utf8")) as { type: string };
  if (type === "web-app") node(["build.mjs"], dir);
  return packModule(dir, type === "web" ? { bundle: () => node([BUNDLE, dir]) } : {});
}
