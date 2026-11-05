// Инструменты сноса: одна мера и одна сверка на все границы. Запуск — из корня репо границы.
//   size <старый> <новый> [пути…]        токены, сложность, строки и случаи тестов; десять худших функций
//   lost <старый> <пути…>                строки и литералы старого кода, которых нет в HEAD
//   shots-pair <папка старых> <папка новых> [порог %]    снимки: доля отличающихся точек
//   dom-diff <старый.json> <новый.json> [фильтр] [--nosize]    деревья DOM из SHOTS_DOM=<файл> npm run shots
//   mutate <таблица.json> -- <команда>   падают ли леса от поломки: [{ file, from, to }]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { TEST } from "../manifest-gate/contract.ts";
import { casesOf, CODE, functionsOf, tokensOf, type Fn } from "./measure.ts";

const MUTANT_MS = 600_000;
const BROWSER_MS = 60_000;

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
const usage = (word: string) => {
  console.error(`demolish: ${word}`);
  process.exit(2);
};
const filesAt = (rev: string, paths: string[]) => git("ls-tree", "-r", "--name-only", rev, "--", ...paths).split("\n").filter((f) => CODE.test(f) && !f.endsWith(".d.ts"));
const textAt = (rev: string, file: string) => git("show", `${rev}:${file}`);
const filled = (text: string) => text.split("\n").filter((l) => /\S/.test(l)).length;

function measure(rev: string, paths: string[]) {
  const m = { tokens: 0, complexity: 0, testLines: 0, cases: 0, fns: [] as Fn[] };
  for (const file of filesAt(rev, paths)) {
    const text = textAt(rev, file);
    if (TEST.test(file)) {
      m.testLines += filled(text);
      m.cases += casesOf(text);
      continue;
    }
    m.tokens += tokensOf(file, text);
    const fns = functionsOf(file, text);
    m.complexity += fns.reduce((n, f) => n + f.complexity, 0);
    m.fns.push(...fns);
  }
  return m;
}

function size(args: string[]) {
  const [oldRev, newRev, ...paths] = args;
  if (!newRev) usage("size <старый> <новый> [пути…]");
  const a = measure(oldRev, paths);
  const b = measure(newRev, paths);
  const row = (name: string, x: number, y: number) => console.log(`${name}: ${x} → ${y}${x ? ` (${y >= x ? "+" : ""}${Math.round(((y - x) / x) * 100)} %)` : ""}`);
  row("токены кода", a.tokens, b.tokens);
  row("сложность", a.complexity, b.complexity);
  row("строки тестов", a.testLines, b.testLines);
  row("случаи тестов", a.cases, b.cases);
  const worst = (m: typeof a) => [...m.fns].sort((x, y) => y.complexity - x.complexity || y.lines - x.lines).slice(0, 10);
  for (const [title, m] of [["до", a], ["после", b]] as const) {
    console.log(`десять худших функций, ${title}:`);
    for (const f of worst(m)) console.log(`  ${f.complexity} · ${f.lines} строк · ${f.name} · ${f.file}`);
  }
}

/** Литералы кода без комментариев: строки целиком и куски между подстановками, текст JSX. */
function literalsOf(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const m of code.matchAll(/"([^"\n]{3,})"|'([^'\n]{3,})'|`([^`]{3,})`/g)) {
    for (const part of (m[1] ?? m[2] ?? m[3]).split(/\$\{[^}]*\}/)) if (part.trim().length > 2) out.push(part.trim());
  }
  for (const m of code.matchAll(/>\s*([^<>{}\n]{3,}?)\s*</g)) if (/\p{L}/u.test(m[1])) out.push(m[1].trim());
  return out;
}

function lost(args: string[]) {
  const [rev, ...paths] = args;
  if (!rev || !paths.length) usage("lost <старый> <пути…>");
  const code = (r: string) => filesAt(r, paths).filter((f) => !TEST.test(f));
  const fresh = code("HEAD").map((f) => textAt("HEAD", f));
  const lines = new Set(fresh.flatMap((t) => t.split("\n").map((l) => l.trim())));
  const whole = fresh.join("\n");
  let total = 0;
  let gone = 0;
  for (const file of code(rev)) {
    const text = textAt(rev, file);
    const candidates = [...new Set([...text.split("\n").map((l) => l.trim()).filter((l) => l.length > 3 && !l.startsWith("//") && !l.startsWith("*")), ...literalsOf(text)])];
    const missing = candidates.filter((l) => !lines.has(l) && !whole.includes(l));
    total += candidates.length;
    gone += missing.length;
    if (missing.length) console.log(`\n=== ${file}: ${missing.length}\n${missing.map((l) => l.slice(0, 200)).join("\n")}`);
  }
  console.log(`\nстрок и литералов старого кода ${total}, пропало ${gone}`);
}

async function shotsPair(args: string[]) {
  const [oldDir, newDir, gate = "0.5"] = args;
  if (!newDir) usage("shots-pair <папка старых> <папка новых> [порог %]");
  const pngs = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".png"));
  const names = pngs(oldDir).filter((f) => existsSync(join(newDir, f)));
  const { chromium } = createRequire(resolve("package.json"))("playwright-core");
  const browser = await chromium.launch({ timeout: BROWSER_MS });
  const page = await (await browser.newContext()).newPage();
  const url = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
  const shares: Array<[string, number]> = [];
  for (const name of names) {
    const share: number = await page.evaluate(
      async ([a, b]: string[]) => {
        const load = (u: string) => new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
        const [x, y] = await Promise.all([load(a), load(b)]);
        const w = Math.max(x.width, y.width);
        const h = Math.max(x.height, y.height);
        const pixels = (img: HTMLImageElement) => {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const g = c.getContext("2d")!;
          g.fillStyle = "#fff";
          g.fillRect(0, 0, w, h);
          g.drawImage(img, 0, 0);
          return g.getImageData(0, 0, w, h).data;
        };
        const [p, q] = [pixels(x), pixels(y)];
        let diff = 0;
        for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 48) diff++;
        return (100 * diff) / (w * h);
      },
      [url(join(oldDir, name)), url(join(newDir, name))],
    );
    shares.push([name, share]);
  }
  await browser.close();
  for (const [name, share] of shares) if (share > Number(gate)) console.log(`${share.toFixed(3)} %  ${name}`);
  const only = (from: string, other: string) => pngs(from).filter((f) => !existsSync(join(other, f)));
  for (const f of only(oldDir, newDir)) console.log(`только в старых: ${f}`);
  for (const f of only(newDir, oldDir)) console.log(`только в новых: ${f}`);
  console.log(`снимков ${names.length}, точка в точку ${shares.filter(([, s]) => s === 0).length}, наибольшее расхождение ${Math.max(0, ...shares.map(([, s]) => s)).toFixed(3)} %`);
}

const SIZE = / \[(\d+x\d+@-?\d+,-?\d+|нет)\]$/;
/** Время, номера и хвостовые пробелы — не разметка. */
const maskTree = (s: string) =>
  s
    .replace(/\d\d:\d\d(:\d\d)?/g, "ЧЧ:ММ")
    .replace(/через \d+ с/g, "через N с")
    .replace(/\d+ ч \d+ мин назад|\d+ мин назад|только что/g, "НАЗАД")
    .replace(/«r[0-9a-z]+»|:r[0-9a-z]+:/g, "ID")
    .replace(/ style=""/g, "")
    .replace(/class="([^"]*?) +"/g, (_m, c: string) => `class="${c}"`);

function domDiff(args: string[]) {
  const nosize = args.includes("--nosize");
  const [oldFile, newFile, filter = ""] = args.filter((x) => x !== "--nosize");
  if (!newFile) usage("dom-diff <старый.json> <новый.json> [фильтр] [--nosize]");
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  const [a, b] = [read(oldFile), read(newFile)];
  const clean = (s: string) => maskTree(s).split("\n").map((l) => (nosize || /lucide-loader/.test(l) ? l.replace(SIZE, "") : l));
  const keys = Object.keys(a).filter((k) => k.includes(filter));
  let same = 0;
  for (const k of keys) {
    if (b[k] === undefined) {
      console.log(`--- ${k}: нет на новом`);
      continue;
    }
    const x = clean(a[k]);
    const y = clean(b[k]);
    if (x.join("\n") === y.join("\n")) {
      same++;
      continue;
    }
    const old = new Set(x);
    const fresh = new Set(y);
    const gone = x.filter((l) => !fresh.has(l));
    const added = y.filter((l) => !old.has(l));
    console.log(`--- ${k}: убрано ${gone.length}, добавлено ${added.length}${gone.length + added.length ? "" : ", порядок другой"}`);
    for (const l of gone.slice(0, 6)) console.log(`  - ${l.trim().slice(0, 300)}`);
    for (const l of added.slice(0, 6)) console.log(`  + ${l.trim().slice(0, 300)}`);
  }
  console.log(`экранов ${keys.length}, совпало ${same}`);
}

function mutate(args: string[]) {
  const dash = args.indexOf("--");
  const table = args[0];
  const command = args.slice(dash + 1).join(" ");
  if (!table || dash < 0 || !command) usage("mutate <таблица.json> -- <команда>");
  const rows = JSON.parse(readFileSync(table, "utf8")) as Array<{ file: string; from: string; to: string }>;
  let restore = () => {};
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      restore();
      process.exit(1);
    });
  }
  const survived: string[] = [];
  for (const { file, from, to } of rows) {
    const text = readFileSync(file, "utf8");
    const label = `${file}: ${from} → ${to}`;
    if (text.split(from).length !== 2) usage(`не один раз или нет: ${label}`);
    restore = () => writeFileSync(file, text);
    writeFileSync(file, text.replace(from, () => to));
    const run = spawnSync(command, { shell: true, stdio: "ignore", timeout: MUTANT_MS });
    restore();
    restore = () => {};
    if (run.status === 0) survived.push(label);
    console.log(`${run.status === 0 ? "выжил" : run.status === null ? "предел" : "убит"} · ${label}`);
  }
  console.log(`мутантов ${rows.length}, выжило ${survived.length}`);
}

const [command, ...rest] = process.argv.slice(2);
const COMMANDS: Record<string, (a: string[]) => void | Promise<void>> = { size, lost, "shots-pair": shotsPair, "dom-diff": domDiff, mutate };
if (!command || !Object.hasOwn(COMMANDS, command)) usage(`команды: ${Object.keys(COMMANDS).join(", ")}`);
await COMMANDS[command](rest);
