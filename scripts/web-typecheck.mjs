// Типы фронта и сервера дизайна: tsc на каждый пакет с tsconfig. Строка на пакет; ошибка — текст компилятора и код 1.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const LIMIT_MIN = 5;

const packages = [...readdirSync(join(ROOT, "web/packages")).map((d) => `web/packages/${d}`), "web/pult", "web/phone", "scripts/design"].filter((p) => existsSync(join(ROOT, p, "tsconfig.json")));
let failed = 0;
for (const p of packages) {
  const r = spawnSync(process.execPath, [TSC, "-p", join(ROOT, p), "--noEmit", "--pretty", "false"], { encoding: "utf8", timeout: LIMIT_MIN * 60_000 });
  if (r.status === 0) {
    console.log(`${p}: ok`);
    continue;
  }
  failed++;
  console.log(`${p}: ошибки${r.error ? ` · не уложился в ${LIMIT_MIN} мин` : ""}\n${r.stdout}${r.stderr}`);
}
process.exit(failed ? 1 : 0);
