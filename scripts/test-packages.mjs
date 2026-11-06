// Тесты Worker-модулей и веба, пакет за пакетом: node scripts/test-packages.mjs [часть пути]. Упавший пакет показывает вывод, остальные доходят.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, globSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_MS = 360_000;
const WINDOWS = process.platform === "win32";
const part = process.argv[2] ?? "";

const manifest = (dir) => JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
const packages = manifest(".")
  .workspaces.filter((w) => /^(workers|web)\//.test(w))
  .flatMap((w) => globSync(w, { cwd: ROOT }).map((d) => d.replaceAll("\\", "/")))
  .filter((d) => d.includes(part) && existsSync(path.join(ROOT, d, "package.json")) && manifest(d).scripts?.test);

const logs = mkdtempSync(path.join(tmpdir(), "test-packages-"));

/** Оболочка, npm, vitest и всё, что они запустили: снимается одним ударом, опросов нет. */
function killTree(pid) {
  if (WINDOWS) spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", timeout: 10_000 });
  else process.kill(-pid, "SIGKILL");
}

let running = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (running) killTree(running.pid);
    process.exit(1);
  });
}

/** Вывод — в файл: зависший потомок не держит прогон. Своя группа процессов на Linux — чтобы предел снял дерево целиком. */
function run(dir) {
  const log = path.join(logs, "out.log");
  const fd = openSync(log, "w");
  const child = spawn("npm test", [], { cwd: path.join(ROOT, dir), shell: true, detached: !WINDOWS, stdio: ["ignore", fd, fd] });
  running = child;
  let late = false;
  const limit = setTimeout(() => {
    late = true;
    killTree(child.pid);
  }, LIMIT_MS);
  return new Promise((done) => {
    child.on("exit", (code) => {
      clearTimeout(limit);
      closeSync(fd);
      done({ ok: code === 0, late, text: readFileSync(log, "utf8") });
    });
  });
}

const seconds = (from) => Math.round((Date.now() - from) / 1000);
const started = Date.now();
let failed = 0;
for (const dir of packages) {
  const from = Date.now();
  const { ok, late, text } = await run(dir);
  console.log(`${ok ? "ok  " : "FAIL"} ${dir} · ${seconds(from)} с${late ? ` · не уложился в ${LIMIT_MS / 60_000} мин` : ""}`);
  if (!ok) {
    failed++;
    console.log(text);
  }
}
console.log(`пакетов ${packages.length} · упало ${failed} · ${seconds(started)} с`);
rmSync(logs, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
