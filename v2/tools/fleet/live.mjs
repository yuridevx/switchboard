// Живые сценарии флота одним запуском: node tools/fleet/live.mjs <флот> <устройство> [машина] [вторая машина] [сессия]
// По очереди: smoke.ts (запросы каждого вида цели), live-server.ts (MCP, вход OAuth, архив, подъём на второй машине),
// live-page.mjs (страница в браузере), live-steps.ts (вопрос и ответ, пара, стоп и старт, откат файлов, скрипт, обращение, точка после
// остановки, поиск с записью, числа Host, перезапуск Host), live-alert.mjs (сбой части доходит админу уведомлением в браузере).
// Сессия не названа — берётся первая свободная на машине. Выход 0 — всё прошло («ждёт выкладки» сбоем не считается).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const [fleet = "test", device = "cli", machine = "devbox", second = "wsl", named] = process.argv.slice(2);
const run = (file, args) => spawnSync(process.execPath, [path.join(here, file), ...args], { cwd: root, encoding: "utf8", timeout: 15 * 60_000 });

let session = named;
if (!session) {
  const r = run("call.ts", [fleet, device, "fleet.list", JSON.stringify({ machine })]);
  try {
    session = JSON.parse(r.stdout).result.sessions.find((s) => s.state === "idle")?.callsign;
  } catch {}
}

const parts = [
  ["запросы", "smoke.ts", [fleet, device]],
  ["серверные функции", "live-server.ts", session && second ? [fleet, device, session, second] : [fleet, device]],
  ["страница в браузере", "live-page.mjs", [fleet, device, machine]],
  ["сценарии", "live-steps.ts", [fleet, device, machine, second]],
  ["оповещение о сбое", "live-alert.mjs", [fleet, device]],
];
let failed = 0;
for (const [title, file, args] of parts) {
  const t0 = Date.now();
  const r = run(file, args);
  const out = (r.stdout ?? "") + (r.status !== 0 && r.stderr ? "\n" + r.stderr.split("\n").slice(-6).join("\n") : "");
  const lines = out.split("\n").filter((l) => /^[✓✗…]/.test(l));
  const ok = lines.filter((l) => l.startsWith("✓")).length, bad = lines.filter((l) => l.startsWith("✗")).length, wait = lines.filter((l) => l.startsWith("…")).length;
  console.log(`\n== ${title}: ${ok} из ${ok + bad}${wait ? `, ждут выкладки ${wait}` : ""} · ${((Date.now() - t0) / 1000).toFixed(0)} с${r.status === 0 ? "" : " · код " + r.status}`);
  for (const l of lines) console.log(l.slice(0, 260));
  if (r.status !== 0) {
    failed++;
    if (!lines.length) console.log(out.split("\n").slice(-8).join("\n"));
  }
}
console.log(failed ? `\nчастей со сбоями: ${failed}` : "\nживой флот прошёл все части");
process.exit(failed ? 1 : 0);
