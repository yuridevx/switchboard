// Живая проверка флота — один список: node tools/fleet/live.mjs <флот> <устройство> [машина] [вторая машина] [сессия]
// Список целиком гонит CI после выкладки main. Сессия у себя запускает одну свою проверку — её файл напрямую.
// Новая функция добавляет свою проверку строкой в LIST — и та идёт на каждом слиянии.
// Модель сессий проверок — SB2_KEY и SB2_MODEL; пары «ключ/модель» для смены модели — SB2_SWITCH через пробел.
// SB2_ENV=prod — прод: идут только проверки с пометкой «годна проду» — свои пробные сессии, чужие не трогают, машины не перезапускают.
// Сессия не названа — берётся первая свободная на машине. Выход 0 — всё прошло («ждёт выкладки» сбоем не считается).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const [fleet = "test", device = "cli", machine = "devbox", second = "wsl", named] = process.argv.slice(2);
const prod = process.env.SB2_ENV === "prod";
const LIMIT_MS = 20 * 60_000; // предел одной проверки
const run = (file, args, env = {}) => spawnSync(process.execPath, [path.join(here, file), ...args], { cwd: root, encoding: "utf8", timeout: LIMIT_MS, env: { ...process.env, ...env } });

let session = named;
if (!session) {
  const r = run("call.ts", [fleet, device, "fleet.list", JSON.stringify({ machine })]);
  try {
    // источник для подъёма копии — на том же ключе, что пробные сессии проверок: чужой ключ с вышедшим пределом её не поднимет
    session = JSON.parse(r.stdout).result.sessions.find((s) => s.state === "idle" && (!process.env.SB2_KEY || s.key === process.env.SB2_KEY))?.callsign;
  } catch {}
}
const pairs = (process.env.SB2_SWITCH ?? "").split(" ").filter(Boolean);

// название · файл · аргументы · окружение · годна проду
const LIST = [
  ["запросы", "smoke.ts", [fleet, device], {}, true],
  ["серверные функции", "live-server.ts", session && second ? [fleet, device, session, second] : [fleet, device], {}, false],
  ["страница в браузере", "live-page.mjs", [fleet, device, machine], {}, true],
  ["разделы страницы", "live-bar.mjs", [fleet, device, machine, second], {}, true],
  ["сценарии", "live-steps.ts", [fleet, device, machine, second], {}, false],
  ["оповещение о сбое", "live-alert.mjs", [fleet, device, "headless"], {}, false],
  ["флоу без окон", "live-flows.mjs", [fleet, device], {}, false],
  ["комментарии к странице", "live-comments.mjs", [fleet, device], {}, false],
  ["аккаунты и модели", "live-accounts.ts", [fleet, device, machine], {}, false],
  ["связь сессий и карточки входящего", "live-comms.ts", [fleet, device, machine], {}, false],
  ["откат разговора", "live-rewind.ts", [fleet, device, machine], {}, false],
  ["разговор на странице", "live-talk.mjs", [fleet, device, machine], {}, false],
  // отказ провайдера на негодный PDF воспроизводится на Claude: у этой проверки свой ключ и модель
  ["ошибки на виду", "live-errors.mjs", [fleet, device, machine], { SB2_KEY: "claude", SB2_MODEL: "claude-haiku-5-5" }, false],
  ["файлы сессии", "live-files.mjs", [fleet, device, machine], { SB2_BIG_MB: process.env.SB2_BIG_MB ?? "10" }, false],
  ["смена модели", "live-switch.mjs", [fleet, device, machine, ...pairs], {}, false],
].filter((c) => !prod || c[4]);

const t00 = Date.now();
const rows = [];
let failed = 0, okAll = 0, badAll = 0;
for (const [title, file, args, env] of LIST) {
  const t0 = Date.now();
  const r = run(file, args, env);
  const out = (r.stdout ?? "") + (r.status !== 0 && r.stderr ? "\n" + r.stderr.split("\n").slice(-6).join("\n") : "");
  const lines = out.split("\n").filter((l) => /^[✓✗…]/.test(l));
  const ok = lines.filter((l) => l.startsWith("✓")).length, bad = lines.filter((l) => l.startsWith("✗")).length, wait = lines.filter((l) => l.startsWith("…")).length;
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  const why = r.status === 0 ? "" : r.status === null ? " · предел проверки вышел" : " · код " + r.status;
  console.log(`\n== ${title}: ${ok} из ${ok + bad}${wait ? `, ждут выкладки ${wait}` : ""} · ${sec} с${why}`);
  // журнал прогона открыт всем: на проде в него идут только названия шагов и числа
  for (const l of lines) console.log(prod ? l.split(" · ")[0] : l.slice(0, 260));
  okAll += ok;
  badAll += bad;
  if (r.status !== 0) {
    failed++;
    if (!prod && (!lines.length || !bad)) console.log(out.split("\n").slice(-8).join("\n"));
  }
  rows.push(`| ${r.status === 0 ? "✓" : "✗"} | ${title} | ${ok} из ${ok + bad} | ${sec} с |`);
}
const total = `живых шагов ${okAll} из ${okAll + badAll} · проверок ${LIST.length - failed} из ${LIST.length} · ${((Date.now() - t00) / 60_000).toFixed(1)} мин`;
console.log(failed ? `\n${total} · проверок со сбоями: ${failed}` : `\n${total} · живой флот прошёл весь список`);
// итог прогона CI: одна сводка на странице прогона
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Живая проверка · флот ${fleet}\n\n${total}\n\n| | проверка | шагов | время |\n|---|---|---|---|\n${rows.join("\n")}\n`);
process.exit(failed ? 1 : 0);
