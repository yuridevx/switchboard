// Проверка частей — один список: node tools/test/run.mjs [части: protocol platform services host web tools keeper]
// Весь список гонит CI на каждый push: каждая часть — своей работой, все разом. Сессия у себя запускает одну свою проверку — файл теста.
// Внутри части — по порядку: типы, тесты, у web — ещё сборка страницы.
// tools — правило импортов и эталоны инструментов выкладки; keeper — go vet и go test.
// Части не названы — идут все, одна за другой: на одной машине чувствительные ко времени тесты страницы под общей нагрузкой падают.
// Снимает всё дерево процессов по пределу: на Windows `timeout` снимает только обёртку.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const LIMIT_MS = 4 * 60_000; // предел одной команды
const PARTS = ["protocol", "platform", "services", "host", "web", "tools", "keeper"];
const named = process.argv.slice(2);
const unknown = named.filter((n) => !PARTS.some((p) => p.includes(n)));
if (unknown.length) throw new Error(`нет такой части: ${unknown.join(", ")}; есть: ${PARTS.join(", ")}`);
const parts = PARTS.filter((p) => !named.length || named.some((n) => p.includes(n)));

function run(cmd, args, cwd, env = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
      else child.kill("SIGKILL");
      out += "\nпредел вышел";
    }, LIMIT_MS);
    // цвета вывода в счёт не идут: в CI vitest красит числа
    child.on("close", (code) => (clearTimeout(timer), res({ code, out: out.replace(/\x1b\[[0-9;]*m/g, ""), ms: Date.now() - t0 })));
  });
}

const report = [];
let failed = 0;
/** Одна команда части: строка итога; сбой — хвост вывода. true — прошла. */
async function check(part, what, cmd, args, cwd, { env, count, tail = -40 } = {}) {
  const r = await run(cmd, args, cwd, env);
  const line = `${r.code === 0 ? "✓" : "✗"} ${part} · ${what}${count ? " " + (count.exec(r.out)?.[1] ?? "?") : ""} · ${(r.ms / 1000).toFixed(1)} с`;
  console.log(r.code === 0 ? line : line + "\n" + r.out.split("\n").slice(...(tail < 0 ? [tail] : [0, tail])).join("\n"));
  report.push(line);
  if (r.code !== 0) failed++;
  return r.code === 0;
}

/** Команды одной части по порядку. */
async function part(p) {
  const dir = path.join(root, p);
  // эталоны инструментов выкладки — встроенным раннером node
  if (p === "tools") return (await check(p, "правило импортов", "node", ["tools/gate/gate.mjs"], root)) && check(p, "тестов", "node", ["--test", '"tools/**/*.test.mjs"'], root, { count: /pass (\d+)/ });
  if (p === "keeper") return (await check(p, "vet", "go", ["vet", "./..."], dir)) && check(p, "тесты", "go", ["test", "./..."], dir);
  // типы пакета — раньше тестов: с ошибкой типов тесты не идут
  if (!(await check(p, "типы", "npx", ["tsc", "--noEmit"], dir, { tail: 30 }))) return;
  await check(p, "тестов", "npm", ["test", "--silent"], dir, { count: /Tests\s+(\d+) passed/ });
  // страница собирается так же, как для выкладки
  if (p === "web") await check(p, "сборка страницы", "npx", ["vite", "build"], dir, { env: { VITE_FLEET: "origin" } });
}

const t0 = Date.now();
for (const p of parts) await part(p);
const total = `частей ${parts.length} · ${((Date.now() - t0) / 1000).toFixed(0)} с${failed ? ` · сбоев ${failed}` : ""}`;
console.log(total);
// итог прогона CI: числа «до» следующей работы берутся отсюда
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Проверка · ${process.platform} · ${total}\n\n${report.sort().map((l) => "- " + l).join("\n")}\n`);
process.exit(failed ? 1 : 0);
