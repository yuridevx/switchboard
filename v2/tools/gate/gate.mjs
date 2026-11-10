// Гейт импортов v2: проверяет устройство кода, а не текст.
// 1. Пакет зовёт другой пакет только по имени `@sb/<пакет>` (вход пакета), не относительным путём внутрь.
// 2. Стрелки — в сторону стабильного: protocol ← platform ← services; protocol ← host; protocol ← web. Обратных и лишних нет.
// 3. Модуль (`src/modules/<имя>/`) зовёт соседний модуль только через его `contract.ts`.
// 5. Колец импортов между файлами пакета нет (импорт только типов кольцом не считается; тесты, мок и стенд не в счёт).
// 4. У имени договора один хозяин — это правило исполняет сам `@sb/protocol` при загрузке (второе объявление бросает).
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

export function check(base = root) {
  const bad = [];
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
