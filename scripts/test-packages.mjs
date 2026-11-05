// Тесты Worker-модулей и веба, пакет за пакетом: node scripts/test-packages.mjs [часть пути]. Упавший пакет показывает вывод, остальные доходят.
import { spawn } from "node:child_process";
import { closeSync, existsSync, globSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_MS = 360_000;
const part = process.argv[2] ?? "";

const manifest = (dir) => JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
const packages = manifest(".")
  .workspaces.filter((w) => /^(workers|web)\//.test(w))
  .flatMap((w) => globSync(w, { cwd: ROOT }).map((d) => d.replaceAll("\\", "/")))
  .filter((d) => d.includes(part) && existsSync(path.join(ROOT, d, "package.json")) && manifest(d).scripts?.test);

const logs = mkdtempSync(path.join(tmpdir(), "test-packages-"));

/** Вывод — в файл: потомок, переживший предел, держит файл, а не прогон. Конец — выход процесса. */
function run(dir) {
  const log = path.join(logs, "out.log");
  const fd = openSync(log, "w");
  const child = spawn("npm test", [], { cwd: path.join(ROOT, dir), shell: true, stdio: ["ignore", fd, fd], timeout: LIMIT_MS });
  return new Promise((done) => {
    child.on("exit", (code, signal) => {
      closeSync(fd);
      done({ ok: code === 0, late: signal !== null, text: readFileSync(log, "utf8") });
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
