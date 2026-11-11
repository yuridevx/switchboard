// Все тесты репо: Node-группа корня (protocol, tools, host, scripts — корневой vitest.config.ts) и пакеты Worker-модулей и веба.
// node scripts/test-packages.mjs [часть пути]. Пакеты идут параллельно; у пакета свой предел, у прогона — общий. Упавший пакет показывает вывод, остальные доходят.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, globSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// буква диска — как у ОС: из d:\ vitest на Windows грузит себя второй копией и не находит раннер
const ROOT = realpathSync.native(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const LIMIT_MS = 360_000;
const TOTAL_MS = 900_000;
// пакет — свой vitest со своим пулом потоков: четверть ядер, не меньше двух
const JOBS = Math.max(2, Math.floor(availableParallelism() / 4));
const WINDOWS = process.platform === "win32";
const part = process.argv[2] ?? "";

const manifest = (dir) => JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
// Node-группа — скрипт test:node корня; часть пути внутри неё — фильтр vitest
const NODE = ["protocol", "tools", "host", "scripts"];
const node = manifest(".").scripts?.["test:node"] && (!part || NODE.some((r) => part.startsWith(r))) ? [{ name: `node (${NODE.join(", ")})`, cwd: ".", cmd: `npm run test:node${part ? ` -- ${part}` : ""}` }] : [];
const packages = [
  ...node,
  ...manifest(".")
    .workspaces.filter((w) => /^(workers|web)\//.test(w))
    .flatMap((w) => globSync(w, { cwd: ROOT }).map((d) => d.replaceAll("\\", "/")))
    .filter((d) => d.includes(part) && existsSync(path.join(ROOT, d, "package.json")) && manifest(d).scripts?.test)
    .map((d) => ({ name: d, cwd: d, cmd: "npm test" })),
];

const logs = mkdtempSync(path.join(tmpdir(), "test-packages-"));

/** Оболочка, npm, vitest и всё, что они запустили: снимается одним ударом, опросов нет. */
function killTree(pid) {
  if (WINDOWS) spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", timeout: 10_000 });
  else process.kill(-pid, "SIGKILL");
}

const running = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const c of running) killTree(c.pid);
    process.exit(1);
  });
}

/** Вывод — в файл: зависший потомок не держит прогон. Своя группа процессов на Linux — чтобы предел снял дерево целиком. */
function run(p, i) {
  const log = path.join(logs, `${i}.log`);
  const fd = openSync(log, "w");
  const child = spawn(p.cmd, [], { cwd: path.join(ROOT, p.cwd), shell: true, detached: !WINDOWS, stdio: ["ignore", fd, fd] });
  running.add(child);
  let late = false;
  const limit = setTimeout(() => {
    late = true;
    killTree(child.pid);
  }, LIMIT_MS);
  return new Promise((done) => {
    child.on("exit", (code) => {
      clearTimeout(limit);
      running.delete(child);
      closeSync(fd);
      done({ ok: code === 0, late, text: readFileSync(log, "utf8") });
    });
  });
}

const seconds = (from) => Math.round((Date.now() - from) / 1000);
const started = Date.now();
let failed = 0;
let over = false;
const total = setTimeout(() => {
  over = true;
  for (const c of running) killTree(c.pid);
}, TOTAL_MS);
const queue = [...packages.entries()];
const left = new Set(packages.map((p) => p.name));
async function worker() {
  for (let next = queue.shift(); next && !over; next = queue.shift()) {
    const [i, p] = next;
    const from = Date.now();
    const { ok, late, text } = await run(p, i);
    left.delete(p.name);
    console.log(`${ok ? "ok  " : "FAIL"} ${p.name} · ${seconds(from)} с${late ? ` · не уложился в ${LIMIT_MS / 60_000} мин` : ""}`);
    if (!ok) {
      failed++;
      console.log(text);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, packages.length) }, worker));
clearTimeout(total);
if (over) console.log(`прогон не уложился в ${TOTAL_MS / 60_000} мин · не дошли: ${[...left].join(", ")}`);
console.log(`пакетов ${packages.length} · упало ${failed} · ${seconds(started)} с`);
rmSync(logs, { recursive: true, force: true });
process.exitCode = failed || over ? 1 : 0;
