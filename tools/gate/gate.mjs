// Гейт импортов v2: проверяет устройство кода, а не текст.
// 1. Пакет зовёт другой пакет только по имени `@sb/<пакет>` (вход пакета), не относительным путём внутрь.
// 2. Стрелки — в сторону стабильного: protocol ← platform ← services; protocol ← host; protocol ← web. Обратных и лишних нет.
// 3. Модуль (`src/modules/<имя>/`) зовёт соседний модуль только через его `contract.ts`.
// 5. Колец импортов между файлами пакета нет (импорт только типов кольцом не считается; тесты, мок и стенд не в счёт).
// 4. У имени договора один хозяин — это правило исполняет сам `@sb/protocol` при загрузке (второе объявление бросает).
// 6. Живая проверка и тест части не ждут времени сами: таймер, сон и своё число предела — только у обвязки (tools/fleet/harness.mjs),
//    стендов, моков и часов теста. Ждут сигнал системы, часы теста или перечитанный факт. Правило читает TypeScript и JavaScript.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript");

const ALLOWED = {
  protocol: [],
  platform: ["protocol"],
  services: ["protocol", "platform"],
  host: ["protocol"],
  web: ["protocol"],
};

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const moduleOf = (pkg, file) => {
  const m = path.relative(path.join(root, pkg, "src", "modules"), file).split(path.sep);
  return m.length > 1 && !m[0].startsWith("..") ? m[0] : null;
};

/** Кольца импортов между файлами пакета: каждое — одной строкой. */
function cycles(base, pkg) {
  const src = path.join(base, pkg, "src");
  if (!fs.existsSync(src)) return [];
  const edges = new Map();
  for (const file of files(src)) {
    if (/\.test\.tsx?$/.test(file) || /[\\/](mock|stand)[\\/]/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const imp of ts.preProcessFile(text, true, true).importedFiles) {
      if (!imp.fileName.startsWith(".")) continue;
      if (/^import type /.test(lines.find((l) => l.includes(`"${imp.fileName}"`)) ?? "")) continue;
      const to = path.resolve(path.dirname(file), imp.fileName);
      (edges.get(file) ?? edges.set(file, new Set()).get(file)).add(to);
    }
  }
  const seen = new Set(), stack = [], found = new Set();
  const walk = (n) => {
    if (stack.includes(n)) return void found.add(stack.slice(stack.indexOf(n)).map((x) => path.relative(base, x).replaceAll(path.sep, "/")).sort().join(" ⇄ "));
    if (seen.has(n)) return;
    seen.add(n);
    stack.push(n);
    for (const m of edges.get(n) ?? []) walk(m);
    stack.pop();
  };
  for (const n of edges.keys()) walk(n);
  return [...found].map((c) => `кольцо импортов: ${c}`);
}

/** Файлы, которые не ждут времени сами: живые проверки флота и тесты частей. Обвязка, её эталоны, стенды, моки и настройка часов теста
 *  в правило не входят: таймер — их дело. */
const LIVE = [/^tools\/fleet\/live-[^/]+\.(mjs|ts)$/, /^tools\/fleet\/smoke\.ts$/, /^tools\/telegram\/live\.mjs$/];
const PART = [/^(protocol|platform|services|host|web)\/.*\.test\.tsx?$/, /^(host|platform)\/test\/.*\.tsx?$/];
const STAND = [/^host\/stand\//, /^platform\/test\/kit\.ts$/, /^services\/test\/stand\.ts$/, /^web\/src\/mock\//, /^web\/src\/test-clock\.ts$/];
/** Вызовы, у которых поле timeout — предел ожидания: ожидание элемента или условия и предел самого теста. */
const WAITS = /^(waitFor\w*|waitUntil|findBy\w+|findAllBy\w+|test|it)$/;

/** Вызовы таймера и свои числа предела в файлах, которые ждут только сигнал: каждое место — строкой с файлом и номером строки.
 *  Живая проверка: предел один — бюджет обвязки, поэтому своё число timeout — любое. Тест части: timeout — нарушение только
 *  как предел ожидания (поле объекта, который отдан вызову ожидания); то же поле в данных запроса или сценария — данные. */
function timers(base) {
  const bad = [];
  const scan = (rel, live) => {
    const p = path.join(base, rel);
    const sf = ts.createSourceFile(p, fs.readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true, p.endsWith(".tsx") ? ts.ScriptKind.TSX : p.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const at = (n) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const what = live ? "в проверке" : "в тесте", instead = live ? "ждите сигнал через обвязку" : "ждите сигнал или часы теста";
    const callee = (c) => (ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "");
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        const name = callee(c);
        const owner = ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) ? c.expression.text : "";
        const timer = (ts.isIdentifier(c) && (name === "setTimeout" || name === "setInterval")) || name === "waitForTimeout" || (owner === "Atomics" && name === "wait") || (owner === "AbortSignal" && name === "timeout");
        if (timer) bad.push(`${at(n)}: таймер ${what} (${owner ? owner + "." : ""}${name}) — ${instead}`);
      }
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "timeout" && ts.isNumericLiteral(n.initializer)) {
        const obj = n.parent, call = obj.parent;
        const waits = live || (ts.isCallExpression(call) && call.arguments.includes(obj) && WAITS.test(callee(call.expression)));
        if (waits) bad.push(`${at(n)}: своё число предела (timeout: ${n.initializer.text}) — ${live ? "предел один, бюджет обвязки" : "ждите сигнал или часы теста"}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  };
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      const rel = path.relative(base, p).replaceAll(path.sep, "/");
      if (!e.isFile() || STAND.some((re) => re.test(rel))) continue;
      if (LIVE.some((re) => re.test(rel))) scan(rel, true);
      else if (PART.some((re) => re.test(rel))) scan(rel, false);
    }
  };
  for (const dir of ["tools", ...Object.keys(ALLOWED)]) walk(path.join(base, dir));
  return bad;
}

export function check(base = root) {
  const bad = [...timers(base)];
  for (const pkg of Object.keys(ALLOWED)) bad.push(...cycles(base, pkg));
  for (const pkg of Object.keys(ALLOWED)) {
    const dir = path.join(base, pkg);
    if (!fs.existsSync(dir)) continue;
    for (const file of files(dir)) {
      const rel = path.relative(base, file).replaceAll(path.sep, "/");
      for (const imp of ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true).importedFiles) {
        const name = imp.fileName;
        if (name.startsWith("@sb/")) {
          const target = name.slice(4).split("/")[0];
          if (name !== "@sb/" + target) bad.push(`${rel}: импорт внутрь пакета ${name} — только вход @sb/${target}`);
          if (target !== pkg && !ALLOWED[pkg].includes(target)) bad.push(`${rel}: ${pkg} не может зависеть от ${target}`);
          continue;
        }
        if (!name.startsWith(".")) continue;
        const to = path.resolve(path.dirname(file), name);
        const toRel = path.relative(base, to).replaceAll(path.sep, "/");
        const toPkg = toRel.split("/")[0];
        if (toPkg !== pkg) {
          bad.push(`${rel}: относительный импорт в чужой пакет ${toRel} — зови @sb/${toPkg}`);
          continue;
        }
        const a = moduleOf(pkg, file), b = moduleOf(pkg, to);
        // список модулей (src/modules/index.ts) и тесты пакета собирают модули целиком — это их дело
        const assembles = rel === pkg + "/src/modules/index.ts" || rel.startsWith(pkg + "/test/") || /\.test\.tsx?$/.test(rel);
        if (b && a !== b && !assembles &&!/\/contract(\.ts)?$/.test(toRel)) bad.push(`${rel}: модуль ${a ?? "ядро"} зовёт модуль ${b} мимо его contract.ts (${toRel})`);
      }
    }
  }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bad = check();
  for (const b of bad) console.error(b);
  console.log(bad.length ? `гейт: нарушений ${bad.length}` : "гейт: чисто");
  process.exit(bad.length ? 1 : 0);
}
