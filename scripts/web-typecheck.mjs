// Типы фронта по пакетам: корневой tsconfig в web/ не заглядывает. node scripts/web-typecheck.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [...readdirSync(join(root, "web/packages")).map((d) => `web/packages/${d}`), "web/pult", "web/phone"].filter((d) => existsSync(join(root, d, "tsconfig.json")));
let failed = 0;
for (const d of dirs) {
  const r = spawnSync("npx", ["tsc", "-p", `${d}/tsconfig.json`, "--noEmit"], { cwd: root, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout}${r.stderr}`.trim();
  console.log(`${d}: ${r.status ? "ошибки" : "ok"}`);
  if (r.status) {
    failed++;
    console.log(out);
  }
}
process.exit(failed ? 1 : 0);
