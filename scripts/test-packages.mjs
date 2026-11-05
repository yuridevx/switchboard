// Тесты Worker-модулей и веба разом: очередь пакетов, вывод пакета — целиком по его окончании. protocol, tools и host — у корневого vitest.
// Запуск: node scripts/test-packages.mjs [часть пути, например web/]. Упавший пакет — код выхода 1 и его вывод; предел на пакет — PACKAGE_MS.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Вдвое выше всей очереди пакетов по одному (180 с, разбор CI 4 нояб.): один пакет дольше не идёт. */
const PACKAGE_MS = 6 * 60_000;

const json = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Папки рабочих областей: «a/*» — каждая папка внутри a. */
function folders(pattern) {
  if (!pattern.endsWith("/*")) return [pattern];
  const parent = pattern.slice(0, -2);
  return readdirSync(join(root, parent)).map((name) => `${parent}/${name}`);
}

/** Пакеты веба и Worker-модулей, у которых есть команда test. */
function testable() {
  const hasTest = (dir) => {
    const file = join(root, dir, "package.json");
    return existsSync(file) && !!json(file).scripts?.test;
  };
  return json(join(root, "package.json"))
    .workspaces.filter((w) => w.startsWith("workers/") || w.startsWith("web/"))
    .flatMap(folders)
    .filter(hasTest);
}

const running = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of running) child.kill();
    process.exit(1);
  });
}

/** Прогнать пакет; в вывод — строка с итогом, при падении и весь его вывод. */
function testPackage(dir) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("npm", ["run", "test", "-w", dir], { cwd: root, shell: process.platform === "win32", timeout: PACKAGE_MS, killSignal: "SIGKILL" });
    running.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code, signal) => {
      running.delete(child);
      const passed = code === 0;
      const limit = signal ? ` · не уложился в ${PACKAGE_MS / 60_000} мин` : "";
      console.log(`${passed ? "ok  " : "FAIL"} ${dir} · ${Math.round((Date.now() - started) / 1000)} с${limit}`);
      if (!passed) console.log(output);
      done(passed);
    });
  });
}

const queue = testable().filter((dir) => dir.includes(process.argv[2] ?? ""));
const total = queue.length;
const started = Date.now();
let failed = 0;
async function worker() {
  while (queue.length) if (!(await testPackage(queue.shift()))) failed++;
}
await Promise.all(Array.from({ length: Math.min(availableParallelism(), total) }, worker));
console.log(`пакетов ${total} · упало ${failed} · ${Math.round((Date.now() - started) / 1000)} с`);
process.exitCode = failed ? 1 : 0;
