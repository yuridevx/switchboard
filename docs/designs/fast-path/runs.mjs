// Замер пути в прод по журналам сессий Claude Code: что сессии запускали у себя.
// node docs/designs/fast-path/runs.mjs <папка журналов проекта в ~/.claude/projects> <с даты, 2026-11-11> [по дату]
// Печатает: push, перед которым сессия гнала больше одной своей проверки, запуски живого списка целиком, выкладки с компьютера
// сессии, время по видам. Одна своя проверка — один файл теста, снимок своего экрана, один живой шаг — остаётся у сессии.
// Вид команды узнаётся по её тексту — счёт грубый: цепочка из нескольких проверок засчитана каждому своему виду целиком.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [root, since, until] = process.argv.slice(2);
if (!root || !since) throw new Error("нужно: <папка журналов> <с даты> [по дату]");
const from = Date.parse(since + "T00:00:00Z"), to = until ? Date.parse(until + "T00:00:00Z") : Infinity;
const WINDOW_MS = 15 * 60_000; // проверка «перед push» — не раньше чем за 15 минут до него в той же сессии

// тексты файлов и образцы поиска внутри команды командой не считаются
const clean = (cmd) => cmd.replace(/<<-?\s*'?"?(\w+)'?"?[^\n]*\n[\s\S]*?\n\s*\1\b/g, " ").replace(/node\s+-e\s+'[^']*'/g, " ").replace(/node\s+-e\s+"(?:[^"\\]|\\.)*"/g, " ").replace(/\b(grep|rg|echo)\b[^|;&\n]*/g, " ").replace(/git\s+commit\b[^\n]*/g, " ").replace(/\\/g, "/");
// скрипт считается запущенным, только когда его зовёт node: путь в cat, git add или wc — не запуск
const run = (file) => new RegExp("(?:node|tsx)\\s+(?:[^\\s;&|]*/)?" + file);
const PART = /(?:^|\/)(?:protocol|platform|services|host|web|keeper)(?:\/|$)/;
const NPM_TEST = /\bnpm\s+(?:run\s+)?test\b/g;
/** Папка части перед командой: последний cd в цепочке, иначе папка вызова. */
const inPart = (c, index, cwd) => PART.test([...c.slice(0, index).matchAll(/\bcd\s+"?([^\s";&|)]+)/g)].at(-1)?.[1] ?? cwd);
const KINDS = {
  "все тесты": (c, cwd) => run("tools/test/run\\.mjs\\s*(?:$|[;&|>\\n])").test(c) || [...c.matchAll(NPM_TEST)].some((m) => !inPart(c, m.index, cwd)),
  "тесты части": (c, cwd) => run("tools/test/run\\.mjs\\s+\\w").test(c) || /\bvitest\b|\bgo\s+test\b/.test(c) || [...c.matchAll(NPM_TEST)].some((m) => inPart(c, m.index, cwd)),
  "типы": (c) => /\bnpx\s+tsc\b|\btsc\s+(?:--noEmit|-b|-p)\b|npm\s+run\s+typecheck/.test(c),
  "гейт": (c) => run("tools/gate/gate\\.mjs").test(c) || /npm\s+run\s+gate\b/.test(c),
  "живые проверки": (c) => run("(?:tools/fleet/(?:live[\\w-]*|smoke)\\.(?:mjs|ts)|tools/telegram/live\\.mjs|web/shots/live[\\w-]*\\.mjs)").test(c),
  "снимки": (c) => /npm\s+run\s+shots\b/.test(c) || run("(?:shots/run\\.mjs|docs/designs/[^\\s/]+/shots\\.mjs)").test(c),
  "сборка": (c) => run("tools/build/build\\.mjs").test(c) || /\bvite\s+build\b/.test(c),
  "выкладка": (c) => /\bwrangler(?:\.mjs)?\s+(?:\S+\s+)?deploy\b|builds\.deploy/.test(c),
};
/** Один файл теста или один тест — своя проверка сессии, а не прогон пакета. */
const oneFile = (c) => /vitest\s+(?:run\s+)?[^;&|\n]*\.test\.|go\s+test\s+[^;&|\n]*-run\b|\s-t\s+["']/.test(c.cmd);
/** Больше одной своей проверки: то, что CI гоняет на каждый push. */
const wide = (c) => c.kinds.some((k) => k === "все тесты" || k === "типы" || k === "гейт") || (c.kinds.includes("тесты части") && !oneFile(c));
/** Живой список целиком, а не один свой шаг. */
const wholeList = (c) => run("tools/fleet/live\\.mjs").test(c.cmd);
const isPush = (c) => /\bgit\s+push\b|\bgh\s+pr\s+create\b/.test(c);

const files = [];
for (const n of fs.readdirSync(root)) if (n.endsWith(".jsonl")) files.push(path.join(root, n));
for (const n of fs.readdirSync(root)) {
  const sub = path.join(root, n, "subagents");
  if (fs.existsSync(sub)) for (const m of fs.readdirSync(sub, { recursive: true })) if (String(m).endsWith(".jsonl")) files.push(path.join(sub, String(m)));
}

const calls = new Map(); // id вызова → { file, at, cwd, cmd, background, end }
const finished = new Map(); // id фонового вызова → время уведомления о его конце
for (const file of files) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes("<tool-use-id>")) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const at = Date.parse(j.timestamp), blocks = j.message?.content;
    if (!Number.isFinite(at)) continue;
    // фоновая команда отвечает оболочке сразу: её конец — уведомление о завершении
    for (const m of line.matchAll(/<tool-use-id>(toolu_\w+)<\/tool-use-id>/g)) if (!finished.has(m[1])) finished.set(m[1], at);
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      // форк копирует историю главной сессии: вызов считается один раз, за первым журналом
      if (b.type === "tool_use" && (b.name === "Bash" || b.name === "PowerShell") && !calls.has(b.id)) calls.set(b.id, { file, at, cwd: String(j.cwd ?? "").replace(/\\/g, "/"), cmd: clean(String(b.input?.command ?? "")), background: !!b.input?.run_in_background });
      else if (b.type === "tool_result" && calls.has(b.tool_use_id)) calls.get(b.tool_use_id).end ??= at;
    }
  }
}
for (const [id, c] of calls) if (c.background && finished.has(id)) c.end = finished.get(id);

const period = [...calls.values()].filter((c) => c.at >= from && c.at < to);
const sum = {};
let any = 0, anyMs = 0;
for (const c of period) {
  c.kinds = Object.keys(KINDS).filter((k) => KINDS[k](c.cmd, c.cwd));
  const ms = (c.end ?? c.at) - c.at;
  if (c.kinds.length) any++, (anyMs += ms);
  for (const k of c.kinds) {
    sum[k] ??= { n: 0, ms: 0 };
    sum[k].n++;
    sum[k].ms += ms;
  }
}
const pushes = period.filter((c) => isPush(c.cmd));
const checked = pushes.filter((p) => period.some((c) => c.file === p.file && c.at <= p.at && p.at - c.at <= WINDOW_MS && wide(c)));
const tests = period.filter((c) => c.kinds.includes("тесты части"));
const live = period.filter((c) => c.kinds.includes("живые проверки"));

console.log(`журналов ${files.length} · вызовов оболочки за период ${period.length}`);
console.log(`запусков проверок, сборок и выкладок: ${any} · ${(anyMs / 3_600_000).toFixed(1)} ч`);
console.log(`push, перед которым шло больше одной своей проверки: ${checked.length} из ${pushes.length}`);
console.log(`запусков тестов части: ${tests.length}, из них один файл: ${tests.filter(oneFile).length}`);
console.log(`живых запусков: ${live.length}, из них список целиком: ${live.filter(wholeList).length}`);
console.log(`выкладок с компьютера сессии: ${sum["выкладка"]?.n ?? 0}`);
for (const [k, v] of Object.entries(sum).sort((a, b) => b[1].ms - a[1].ms)) console.log(`  ${k}: ${v.n} · ${(v.ms / 3_600_000).toFixed(2)} ч`);
