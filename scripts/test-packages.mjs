// Тесты пакетов Worker и веб по очереди: npm run test:workers [часть пути]. Упавший пакет — его вывод и код 1; предел на пакет словами.
// Вывод пакета — файл dist/test-packages/<пакет>.log, а не канал: зависший потомок не держит прогон, конец пакета — конец его процесса.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = join(ROOT, "dist", "test-packages");
const LIMIT_MIN = 6;
const seconds = (from) => Math.round((Date.now() - from) / 1000);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

const part = process.argv[2] ?? "";
const packages = readJson(join(ROOT, "package.json"))
  .workspaces.flatMap((w) => (w.endsWith("/*") ? readdirSync(join(ROOT, w.slice(0, -2))).map((d) => w.slice(0, -1) + d) : [w]))
  .filter((p) => /^(workers|web)\//.test(p) && p.includes(part))
  .filter((p) => existsSync(join(ROOT, p, "package.json")) && readJson(join(ROOT, p, "package.json")).scripts?.test);

mkdirSync(LOGS, { recursive: true });
const started = Date.now();
let failed = 0;
for (const p of packages) {
  const from = Date.now();
  const log = join(LOGS, `${p.replaceAll("/", "-")}.log`);
  const out = openSync(log, "w");
  const child = spawn("npm test", [], { cwd: join(ROOT, p), shell: true, stdio: ["ignore", out, out], timeout: LIMIT_MIN * 60_000, killSignal: "SIGKILL" });
  const [code, signal] = await once(child, "exit");
  closeSync(out);
  if (code === 0) {
    console.log(`ok   ${p} · ${seconds(from)} с`);
    continue;
  }
  failed++;
  console.log(`FAIL ${p} · ${seconds(from)} с${signal ? ` · не уложился в ${LIMIT_MIN} мин` : ""}`);
  console.log(readFileSync(log, "utf8"));
}
console.log(`пакетов ${packages.length} · упало ${failed} · ${seconds(started)} с`);
process.exit(failed ? 1 : 0);
