// Проверка частей — один список: node tools/test/run.mjs [часть имени: protocol, platform, services, host, web, tools, keeper]
// Весь список гонит CI на каждый push, на Linux и Windows. Сессия у себя запускает одну свою проверку — файл теста.
// По части: типы и тесты пакета; у web — ещё сборка страницы; tools — эталоны инструментов выкладки; keeper — go vet и go test.
// Снимает всё дерево процессов по пределу: на Windows `timeout` снимает только обёртку.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const LIMIT_MS = 6 * 60_000; // предел одной команды
const only = process.argv[2];
const wanted = (part) => !only || part.includes(only);

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
  console.log(line);
  report.push(line);
  if (r.code === 0) return true;
  failed++;
  console.log(r.out.split("\n").slice(...(tail < 0 ? [tail] : [0, tail])).join("\n"));
  return false;
}

for (const p of ["protocol", "platform", "services", "host", "web"].filter(wanted)) {
  const dir = path.join(root, p);
  // типы пакета — раньше тестов: с ошибкой типов тесты не идут
  if (!(await check(p, "типы", "npx", ["tsc", "--noEmit"], dir, { tail: 30 }))) continue;
  await check(p, "тестов", "npm", ["test", "--silent"], dir, { count: /Tests\s+(\d+) passed/ });
  // страница собирается так же, как для выкладки
  if (p === "web") await check(p, "сборка страницы", "npx", ["vite", "build"], dir, { env: { VITE_FLEET: "origin" } });
}
// эталоны инструментов выкладки — встроенным раннером node
if (wanted("tools")) await check("tools", "тестов", "node", ["--test", '"tools/**/*.test.mjs"'], root, { count: /pass (\d+)/ });
if (wanted("keeper")) {
  const dir = path.join(root, "keeper");
  if (await check("keeper", "vet", "go", ["vet", "./..."], dir)) await check("keeper", "тесты", "go", ["test", "./..."], dir);
}
// итог прогона CI: числа «до» следующей работы берутся отсюда
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Проверка · ${process.platform}\n\n${report.map((l) => "- " + l).join("\n")}\n`);
process.exit(failed ? 1 : 0);
