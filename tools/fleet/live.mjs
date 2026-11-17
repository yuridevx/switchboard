// Живая проверка флота — один список: node tools/fleet/live.mjs <флот> <устройство> [машина] [вторая машина] [сессия]
// Список целиком гонит CI после выкладки main. Сессия у себя запускает одну свою проверку — её файл напрямую.
// Новая функция добавляет свою проверку строкой в LIST — и та идёт на каждом слиянии.
// Проверки идут одновременно, у каждой свои пробные сессии. Дорожек три:
//   тихая  — никого не задевает: все тихие идут разом на первой машине;
//   шумная — перезапускает Host своей машины: шумные идут по очереди на второй машине, рядом с тихими;
//   одна   — меняет общее для флота (аккаунты Claude): идёт первой, одна, до остальных.
// Модель сессий проверок — SB2_KEY и SB2_MODEL; пары «ключ/модель» для смены модели — SB2_SWITCH через пробел.
// SB2_ENV=prod — прод: идут только проверки с пометкой «годна проду» — свои пробные сессии, чужие не трогают, машины не перезапускают.
// Сессия не названа — берётся первая свободная на машине. Выход 0 — всё прошло («ждёт выкладки» сбоем не считается).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const [fleet = "test", device = "cli", machine = "devbox", second = "wsl", named] = process.argv.slice(2);
const prod = process.env.SB2_ENV === "prod";
const LIMIT_MS = 4 * 60_000; // предел одной проверки

/** Одна проверка отдельным процессом: вывод целиком, код выхода, время; предел вышел — процесс снят, код null. */
const run = (file, args, env = {}) => new Promise((done) => {
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(here, file), ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), LIMIT_MS);
  child.on("close", (status) => (clearTimeout(timer), done({ status, stdout, stderr, ms: Date.now() - t0 })));
});

let session = named;
if (!session) {
  const r = spawnSync(process.execPath, [path.join(here, "call.ts"), fleet, device, "fleet.list", JSON.stringify({ machine })], { cwd: root, encoding: "utf8", timeout: 60_000 });
  try {
    // источник для подъёма копии — на том же ключе, что пробные сессии проверок: чужой ключ с вышедшим пределом её не поднимет
    session = JSON.parse(r.stdout).result.sessions.find((s) => s.state === "idle" && (!process.env.SB2_KEY || s.key === process.env.SB2_KEY))?.callsign;
  } catch {}
}
const pairs = (process.env.SB2_SWITCH ?? "").split(" ").filter(Boolean);

const QUIET = "тихая", NOISY = "шумная", ALONE = "одна";
// название · файл · аргументы · окружение · годна проду · дорожка
const LIST = [
  ["запросы", "smoke.ts", [fleet, device], {}, true, QUIET],
  ["серверные функции", "live-server.ts", session && second ? [fleet, device, session, second] : [fleet, device], {}, false, QUIET],
  ["страница в браузере", "live-page.mjs", [fleet, device, machine], {}, true, QUIET],
  ["разделы страницы", "live-bar.mjs", [fleet, device, machine], {}, true, QUIET],
  ["оповещение о сбое", "live-alert.mjs", [fleet, device, "headless"], {}, false, QUIET],
  ["флоу без окон", "live-flows.mjs", [fleet, device], {}, false, QUIET],
  ["комментарии к странице", "live-comments.mjs", [fleet, device], {}, false, QUIET],
  // длинные проверки идут частями (SB2_PART): у каждой части свои сессии, части идут разом
  ["откат разговора", "live-rewind.ts", [fleet, device, machine], { SB2_PART: "rewind" }, false, QUIET],
  ["пара: ведущая и ведомый", "live-rewind.ts", [fleet, device, machine], { SB2_PART: "pair" }, false, QUIET],
  ["разговор на странице: ходы", "live-talk.mjs", [fleet, device, machine], { SB2_PART: "turn" }, false, QUIET],
  ["разговор на странице: экран", "live-talk.mjs", [fleet, device, machine], { SB2_PART: "screen" }, false, QUIET],
  ["аккаунты и модели", "live-accounts.ts", [fleet, device, machine], { SB2_PART: "rest" }, false, QUIET],
  // отказ провайдера на негодный PDF воспроизводится на Claude: у этой проверки свой ключ и модель
  ["ошибки на виду", "live-errors.mjs", [fleet, device, machine], { SB2_KEY: "claude", SB2_MODEL: "claude-haiku-5-5" }, false, QUIET],
  ["файлы сессии", "live-files.mjs", [fleet, device, machine], { SB2_BIG_MB: process.env.SB2_BIG_MB ?? "10" }, false, QUIET],
  ["смена модели", "live-switch.mjs", [fleet, device, machine, ...pairs], {}, false, QUIET],
  ["сценарии", "live-steps.ts", [fleet, device, machine], { SB2_PART: "one" }, false, QUIET],
  ["связь сессий и карточки входящего", "live-comms.ts", [fleet, device, machine], { SB2_PART: "talk" }, false, QUIET],
  // вторая машина: её Host перезапускает подмена — всё, что трогает вторую машину, идёт с ней в одной очереди
  ["сценарии: вторая машина", "live-steps.ts", [fleet, device, machine, second], { SB2_PART: "far" }, false, NOISY],
  ["подмена Host посреди хода", "live-comms.ts", [fleet, device, second], { SB2_PART: "swap" }, false, NOISY],
  // заводит и убирает негодный аккаунт Claude флота: при нём чужой ход на Claude получил бы лишний переход — идёт до всех
  ["аккаунты: негодный токен", "live-accounts.ts", [fleet, device, machine], { SB2_PART: "token" }, false, ALONE],
].filter((c) => !prod || c[4]);

const t00 = Date.now();
const rows = [];
let failed = 0, okAll = 0, badAll = 0;
/** Проверка от запуска до своего блока в журнале: блок печатается целиком, когда она кончилась. */
async function check([title, file, args, env]) {
  const r = await run(file, args, env);
  const out = r.stdout + (r.status !== 0 && r.stderr ? "\n" + r.stderr.split("\n").slice(-6).join("\n") : "");
  const lines = out.split("\n").filter((l) => /^[✓✗…]/.test(l));
  const ok = lines.filter((l) => l.startsWith("✓")).length, bad = lines.filter((l) => l.startsWith("✗")).length, wait = lines.filter((l) => l.startsWith("…")).length;
  const sec = (r.ms / 1000).toFixed(0);
  const why = r.status === 0 ? "" : r.status === null ? " · предел проверки вышел" : " · код " + r.status;
  const block = [`\n== ${title}: ${ok} из ${ok + bad}${wait ? `, ждут выкладки ${wait}` : ""} · ${sec} с${why}`];
  // журнал прогона открыт всем: на проде в него идут только названия шагов и числа
  for (const l of lines) block.push(prod ? l.split(" · ")[0] : l.slice(0, 260));
  if (r.status !== 0 && !prod && (!lines.length || !bad)) block.push(out.split("\n").slice(-8).join("\n"));
  console.log(block.join("\n"));
  okAll += ok;
  badAll += bad;
  if (r.status !== 0) failed++;
  rows.push(`| ${r.status === 0 ? "✓" : "✗"} | ${title} | ${ok} из ${ok + bad} | ${sec} с |`);
}
const lane = (name) => LIST.filter((c) => c[5] === name);
const inTurn = async (checks) => { for (const c of checks) await check(c); };
await inTurn(lane(ALONE));
await Promise.all([...lane(QUIET).map(check), inTurn(lane(NOISY))]);

const total = `живых шагов ${okAll} из ${okAll + badAll} · проверок ${LIST.length - failed} из ${LIST.length} · ${((Date.now() - t00) / 60_000).toFixed(1)} мин`;
console.log(failed ? `\n${total} · проверок со сбоями: ${failed}` : `\n${total} · живой флот прошёл весь список`);
// итог прогона CI: одна сводка на странице прогона
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Живая проверка · флот ${fleet}\n\n${total}\n\n| | проверка | шагов | время |\n|---|---|---|---|\n${rows.join("\n")}\n`);
process.exit(failed ? 1 : 0);
