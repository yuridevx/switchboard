// Числа идиоматичности React-кода фронта: компоненты внутри фабрик, состояние в замыканиях, ручной DOM. node scripts/react-metrics.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d) => readdirSync(d).flatMap((n) => {
  if (n === "node_modules" || n === "dist" || n === "test" || n === "stand") return [];
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
});

const files = walk(join(root, "web"));
const rows = [];
for (const f of files) {
  const s = readFileSync(f, "utf8");
  const lines = s.split("\n");
  const m = {
    file: relative(root, f).replaceAll("\\", "/"),
    lines: lines.length,
    // компонент (function с заглавной) с отступом: объявлен внутри другой функции
    inner: lines.filter((l) => /^\s+(const \w+ = memo\(function |function )[A-Z]\w*\(/.test(l)).length,
    // состояние в замыкании фабрики: let и new Map/Set с отступом ровно в два пробела
    closure: lines.filter((l) => /^ {2}(let \w+|const \w+(: [^=]+)? = new (Map|Set)\b)/.test(l)).length,
    changed: (s.match(/app\.changed\(\)/g) ?? []).length,
    dom: (s.match(/\.querySelector|document\.getElementById|\.value = |\.classList\.|\.style\.\w+ = /g) ?? []).length,
    states: (s.match(/useState[<(]/g) ?? []).length,
    effects: (s.match(/useEffect\(/g) ?? []).length,
    copies: (s.match(/app\.use\(\(\) => \[\.\.\.|\? \{ \.\.\.x \}/g) ?? []).length,
  };
  if (m.inner || m.closure || m.changed || m.dom || m.lines > 400) rows.push(m);
}
rows.sort((a, b) => b.inner + b.closure + b.changed - (a.inner + a.closure + a.changed));
const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
for (const r of rows) console.log(`${r.file.padEnd(46)} строк ${String(r.lines).padStart(5)} · внутр.комп ${String(r.inner).padStart(3)} · замыкание ${String(r.closure).padStart(3)} · changed ${String(r.changed).padStart(3)} · DOM ${String(r.dom).padStart(3)} · useState ${String(r.states).padStart(3)} · useEffect ${String(r.effects).padStart(2)}`);
console.log(`ИТОГО: файлов ${rows.length} · внутренних компонентов ${sum("inner")} · состояний в замыкании ${sum("closure")} · app.changed ${sum("changed")} · ручной DOM ${sum("dom")} · useState ${sum("states")} · файлов > 400 строк ${rows.filter((r) => r.lines > 400).length}`);
