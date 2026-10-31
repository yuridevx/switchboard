// npm по очереди: несколько исполнителей в одном монорепо не пишут lock-файл одновременно.
// Запуск: node scripts/npm-serial.mjs install -w @switchboard/relay --save-exact x@1.2.3
import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = join(root, "node_modules", ".npm-serial.lock");
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (let i = 0; ; i++) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    if (i % 30 === 0) console.error("npm-serial: жду, пока другой исполнитель закончит npm");
    wait(2000);
  }
}
try {
  const r = spawnSync("npm", process.argv.slice(2), { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(lock, { recursive: true, force: true });
}
