// Типы фронта: tsc каждого пакета веба и сервера дизайна; строка на пакет, ошибки — текстом компилятора.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_MS = 300_000;
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const packages = readdirSync(path.join(ROOT, "web", "packages")).map((d) => `web/packages/${d}`);
let failed = 0;
for (const dir of [...packages, "web/pult", "web/phone", "scripts/design"]) {
  if (!existsSync(path.join(ROOT, dir, "tsconfig.json"))) continue;
  const r = spawnSync(process.execPath, [TSC, "-p", path.join(ROOT, dir), "--noEmit"], { encoding: "utf8", timeout: LIMIT_MS });
  if (r.status === 0) {
    console.log(`${dir}: ok`);
    continue;
  }
  failed++;
  console.log(`${dir}: ошибки\n${r.stdout}${r.stderr}${r.error ? r.error.message : ""}`);
}
process.exitCode = failed ? 1 : 0;
