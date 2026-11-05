// Типы фронта по пакетам: корневой tsconfig в web/ не заглядывает. node scripts/web-typecheck.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packages = readdirSync(join(root, "web/packages")).map((name) => `web/packages/${name}`);
let failed = false;
for (const dir of [...packages, "web/pult", "web/phone"]) {
  if (!existsSync(join(root, dir, "tsconfig.json"))) continue;
  const r = spawnSync("npx", ["tsc", "-p", `${dir}/tsconfig.json`, "--noEmit"], { cwd: root, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  console.log(`${dir}: ${r.status ? "ошибки" : "ok"}`);
  if (r.status) {
    failed = true;
    console.log(`${r.stdout}${r.stderr}`.trim());
  }
}
process.exitCode = failed ? 1 : 0;
