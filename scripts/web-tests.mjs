// Тесты фронта по пакетам: что упало и сколько прошло. node scripts/web-tests.mjs [часть пути пакета]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const filter = process.argv[2] ?? "";
const dirs = [...readdirSync(join(root, "web/packages")).map((d) => `web/packages/${d}`), "web/pult", "web/phone"].filter((d) => existsSync(join(root, d, "test")) && d.includes(filter));
let failed = 0;
for (const d of dirs) {
  const r = spawnSync("npx", ["vitest", "run", "--reporter=dot"], { cwd: join(root, d), encoding: "utf8", shell: true, maxBuffer: 256 * 1024 * 1024 });
  const lines = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  for (const l of lines) if (/^ *FAIL |Tests  /.test(l)) console.log(`${d}: ${l.trim().slice(0, 170)}`);
  if (r.status) failed++;
}
process.exit(failed ? 1 : 0);
