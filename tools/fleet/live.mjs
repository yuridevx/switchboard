// Живая проверка флота — один список: node tools/fleet/live.mjs <флот> <устройство> [машина] [вторая машина]
// Строки и выбор — tools/fleet/list.mjs; здесь только запуск выбранного. Место прогона: флот в коробке — коробка (CI до слияния, весь список);
// SB2_ENV=prod — прод; иначе живой флот: после каждого слияния идут швы, SB2_ALL=1 — весь список (ручной запуск выкладки, list=весь).
// Сессия у себя запускает одну свою проверку — через список, по названию:
//   SB2_ONLY="смена модели" node tools/box/box.mjs node tools/fleet/live.mjs box cli m1 m2
// Новая функция добавляет свою проверку строкой в list.mjs — и та идёт на каждом слиянии в коробке.
// Проверки идут одновременно, у каждой свои пробные сессии: сначала дорожка «одна» по одной, потом тихие разом рядом с очередью шумных.
// Модель сессий проверок — SB2_KEY и SB2_MODEL; пары «ключ/модель» для смены модели — SB2_SWITCH через пробел.
// Выход 0 — всё прошло.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { lacks, local, newTag } from "./harness.mjs";
import { ALONE, BOX, FLEET, NOISY, PROD, QUIET, rows, select } from "./list.mjs";
import { appendSteps, readSteps, stamp } from "./steps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const [fleet = "test", device = "cli", machine = "devbox", second = "wsl"] = process.argv.slice(2);
// одна проверка списка — по названию: SB2_ONLY="смена модели"
const only = process.env.SB2_ONLY ?? "";
const prod = process.env.SB2_ENV === "prod";
const place = local() ? BOX : prod ? PROD : FLEET;
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

// доля списка: SB2_SHARD=номер/всего. Работа CI делит список между коробками — каждая на своём раннере, проверкам не тесно
const [shard, shards] = (process.env.SB2_SHARD ?? "1/1").split("/").map(Number);
const pairs = (process.env.SB2_SWITCH ?? "").split(" ").filter(Boolean);
// install — служба ОС ставится на этом компьютере: только раннер CI (SB2_INSTALL=1)
const lacking = (what) => (what === "install" ? process.env.SB2_INSTALL !== "1" : lacks(what));
const LIST = select(rows({ fleet, device, machine, second, pairs, bigMb: process.env.SB2_BIG_MB }), { place, shard, shards, only, lacks: lacking, all: process.env.SB2_ALL === "1" });
if (only && !LIST.length) throw new Error(`в списке нет проверки «${only}» — или у этого флота нет того, что ей нужно`);

// журнал шагов: строка общей формы на каждый шаг — в файл SB2_STEPS; работа CI сохраняет его при прогоне, читает tools/test/history.mjs
const STEPS = process.env.SB2_STEPS;
const journal = { place: place === BOX ? `коробка ${process.platform === "win32" ? "windows" : "linux"}` : `флот ${fleet}`, commit: process.env.GITHUB_SHA, run: Number(process.env.GITHUB_RUN_ID) || undefined, bare: prod };

const t00 = Date.now();
const table = [];
let failed = 0, okAll = 0, badAll = 0;
/** Проверка от запуска до своего блока в журнале: блок печатается целиком, когда она кончилась. */
async function check([title, file, args, env, , laneOf]) {
  // название, дорожку, метку и файл для шагов проверке называет список: проверка на входе check (harness.mjs) отдаёт шаги строками журнала
  const tag = newTag();
  const own = path.join(os.tmpdir(), `sb2-steps-${process.pid}-${tag}.jsonl`);
  const r = await run(file, args, { ...env, SB2_CHECK: title, SB2_LANE: laneOf, SB2_TAG: tag, SB2_STEPS: own });
  const told = fs.existsSync(own) ? readSteps(fs.readFileSync(own, "utf8")) : [];
  fs.rmSync(own, { force: true });
  // слова ошибки упавшей проверки — без строк стека: слова идут первыми, стек — последним
  const words = r.status !== 0 && r.stderr ? r.stderr.split("\n").filter((l) => l.trim() && !/^\s+at /.test(l)).slice(-6).join("\n") : "";
  const out = r.stdout + (words ? "\n" + words : "");
  // шаги — строки журнала самой проверки; не отдала ни одной и кончилась не нулём — красная строка о ней самой
  const steps = stamp(title, told, r.status, words, { ...journal, t: Date.now() });
  if (STEPS) appendSteps(STEPS, steps);
  const lines = out.split("\n").filter((l) => /^[✓✗]/.test(l));
  const ok = steps.filter((s) => s.ok).length, bad = steps.length - ok;
  const sec = (r.ms / 1000).toFixed(0);
  const why = r.status === 0 ? "" : r.status === null ? " · предел проверки вышел" : " · код " + r.status;
  const block = [`\n== ${title}: ${ok} из ${ok + bad} · ${sec} с${why}`];
  // журнал прогона открыт всем: на проде в него идут только названия шагов и числа
  for (const l of lines) block.push(prod ? l.split(" · ")[0] : l.slice(0, 260));
  if (r.status !== 0 && !prod && (!lines.length || !lines.some((l) => l.startsWith("✗")))) block.push(out.split("\n").slice(-8).join("\n"));
  // процесс снят жёстко — своё проверка убрать не успела: агент находит остатки по метке
  if (r.status === null) block.push(`проверка снята по пределу: её сессии и папки с меткой ${tag} могли остаться на флоте`);
  console.log(block.join("\n"));
  okAll += ok;
  badAll += bad;
  if (r.status !== 0) failed++;
  table.push(`| ${r.status === 0 ? "✓" : "✗"} | ${title} | ${ok} из ${ok + bad} | ${sec} с |`);
}
const lane = (name) => LIST.filter((c) => c[5] === name);
const inTurn = async (checks) => { for (const c of checks) await check(c); };
await inTurn(lane(ALONE));
await Promise.all([...lane(QUIET).map(check), inTurn(lane(NOISY))]);

const total = `живых шагов ${okAll} из ${okAll + badAll} · проверок ${LIST.length - failed} из ${LIST.length} · ${((Date.now() - t00) / 60_000).toFixed(1)} мин`;
console.log(failed ? `\n${total} · проверок со сбоями: ${failed}` : `\n${total} · живой флот прошёл весь список`);
// итог прогона CI: одна сводка на странице прогона
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Живая проверка · флот ${fleet}\n\n${total}\n\n| | проверка | шагов | время |\n|---|---|---|---|\n${table.join("\n")}\n`);
process.exit(failed ? 1 : 0);
