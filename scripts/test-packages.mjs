// Тесты Worker-модулей и веба разом: по пакету на ядро, вывод — целиком по окончании пакета. protocol, tools и host — у корневого vitest.
// Запуск: node scripts/test-packages.mjs [часть пути, например web/]. Упавший пакет — код выхода 1 и его вывод; предел на пакет — PACKAGE_MS.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Вдвое выше всей очереди пакетов по одному (180 с, разбор CI 4 нояб.): один пакет дольше не идёт. */
const PACKAGE_MS = 6 * 60_000;

function workspaces() {
  const out = [];
  for (const w of JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces.filter((x) => x.startsWith("workers/") || x.startsWith("web/"))) {
    const dirs = w.endsWith("/*") ? readdirSync(join(root, w.slice(0, -2))).map((d) => `${w.slice(0, -2)}/${d}`) : [w];
    for (const d of dirs) {
      const p = join(root, d, "package.json");
      if (existsSync(p) && JSON.parse(readFileSync(p, "utf8")).scripts?.test) out.push(d);
    }
  }
  return out;
}

const live = new Set();
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { for (const c of live) c.kill(); process.exit(1); });

function run(dir) {
  return new Promise((done) => {
    const t0 = Date.now();
    const c = spawn("npm", ["run", "test", "-w", dir], { cwd: root, shell: process.platform === "win32", timeout: PACKAGE_MS, killSignal: "SIGKILL" });
    live.add(c);
    let text = "";
    c.stdout.on("data", (d) => (text += d));
    c.stderr.on("data", (d) => (text += d));
    c.on("close", (code, signal) => {
      live.delete(c);
      const ok = code === 0;
      const why = signal ? ` · не уложился в ${PACKAGE_MS / 60_000} мин` : "";
      console.log(`${ok ? "ok  " : "FAIL"} ${dir} · ${Math.round((Date.now() - t0) / 1000)} с${why}`);
      if (!ok) console.log(text);
      done(ok);
    });
  });
}

const queue = workspaces().filter((d) => d.includes(process.argv[2] ?? ""));
const total = queue.length;
const t0 = Date.now();
const results = [];
await Promise.all(Array.from({ length: Math.min(availableParallelism(), total) }, async () => {
  for (let d = queue.shift(); d; d = queue.shift()) results.push(await run(d));
}));
const failed = results.filter((x) => !x).length;
console.log(`пакетов ${total} · упало ${failed} · ${Math.round((Date.now() - t0) / 1000)} с`);
process.exit(failed ? 1 : 0);
