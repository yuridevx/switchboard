// Числа идиоматичности React-кода фронта. node scripts/react-metrics.mjs
// Считаются только `let`, Map и Set на отступе 2 внутри фабрик create*: локальные переменные функций верхнего уровня не состояние модуля.
// Служебные ссылки — что не рисуется: снимок ядра, таймеры и счётчики ядра, защита от устаревшего ответа.
// Состояние вида — всё остальное: его цель 0, оно живёт в снимке createStore.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    if (n === "node_modules" || n === "dist" || n === "test" || n === "stand") return [];
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });

/** Что служебное и почему: ключ — файл и имя, новое имя с тем же словом в другом файле служебным само не становится. */
const SERVICE = {
  "web/packages/core/src/bus.ts:subs": "подписчики выборок",
  "web/packages/core/src/bus.ts:queued": "уведомление в такте",
  "web/packages/core/src/lifecycle.ts:hidden": "страница скрыта",
  "web/packages/core/src/lifecycle.ts:life": "очередь ухода и возврата",
  "web/packages/core/src/link.ts:pending": "начатые запросы",
  "web/packages/core/src/link.ts:lk": "соединение",
  "web/packages/core/src/link.ts:since": "since машин по roster: одно сравнение на приложение",
  "web/packages/core/src/link.ts:returned": "вернувшиеся соединения машин",
  "web/packages/core/src/registry.ts:commandOwner": "владельцы команд",
  "web/packages/core/src/registry.ts:frameOwner": "реестр модулей",
  "web/packages/core/src/registry.ts:screenOwner": "реестр модулей",
  "web/packages/core/src/registry.ts:markOwner": "реестр модулей",
  "web/packages/core/src/router.ts:routed": "адрес маршрута",
  "web/packages/core/src/router.ts:depth": "глубина истории",
  "web/packages/core/src/state.ts:state": "сам снимок",
  "web/packages/core/src/state.ts:timer": "таймер",
  "web/pult/modules/journal/src/store.ts:epoch": "защита от устаревшего ответа",
};
const NAME = /^ {2}(?:let (\w+)|const (\w+)(?:: [^=]+)? = new (?:Map|Set)\b)/;

/** Имена `let`, Map и Set на отступе 2 внутри фабрик create*. */
function inFactories(lines) {
  const out = [];
  let inside = false;
  for (const l of lines) {
    if (/^(export )?(async )?function create\w*\(/.test(l)) inside = true;
    else if (l === "}") inside = false;
    else if (inside) {
      const m = NAME.exec(l);
      if (m) out.push(m[1] ?? m[2]);
    }
  }
  return out;
}

const rows = [];
const controls = { rawButtons: 0, rawFields: 0, kit: 0 };
const services = {};
const viewState = [];
for (const f of walk(join(root, "web"))) {
  const s = readFileSync(f, "utf8");
  const lines = s.split("\n");
  const file = relative(root, f).replaceAll("\\", "/");
  const names = inFactories(lines);
  const view = names.filter((n) => !(`${file}:${n}` in SERVICE));
  for (const n of names) if (`${file}:${n}` in SERVICE) services[`${n} (${SERVICE[`${file}:${n}`]})`] = (services[`${n} (${SERVICE[`${file}:${n}`]})`] ?? 0) + 1;
  for (const n of view) viewState.push(`${file}: ${n}`);
  const m = {
    file,
    lines: lines.length,
    // компонент (function с заглавной) с отступом: объявлен внутри другой функции
    // и компонент как значение: стрелка или вызов в поле view определения модуля, стрелка с заглавным именем, фабрика компонентов
    inner: lines.filter((l) => /^\s+(const \w+ = memo\(function |function )[A-Z]\w*\(/.test(l) || (file.endsWith("/module.tsx") && /^\s+view: (\(|\w+ =>|\w+\()/.test(l)) || /^\s+const [A-Z]\w* = (\([^)]*\)|\w+) =>/.test(l) || /^\s+const \w+ = \(\w+: ComponentType/.test(l)).length,
    contexts: (s.match(/= createContext[<(]/g) ?? []).length,
    letApp: (s.match(/^\s+let app:/gm) ?? []).length,
    service: names.length - view.length,
    view: view.length,
    changed: (s.match(/app\.changed\(\)/g) ?? []).length,
    dom: (s.match(/\.querySelector|document\.getElementById|\.value = |\.classList\.|\.style\.\w+ = /g) ?? []).length,
    states: (s.match(/useState[<(]/g) ?? []).length,
    // кнопки и поля мимо набора: файлы самого набора не считаются
    rawButtons: file.startsWith("web/packages/ui/") ? 0 : (s.match(/<button\b/g) ?? []).length,
    rawFields: file.startsWith("web/packages/ui/") ? 0 : (s.match(/<(input|textarea|select)\b/g) ?? []).length,
    kit: file.startsWith("web/packages/ui/") ? 0 : (s.match(/<(Btn|Cta|LinkBtn|Chip|Chips|Tabs|In|CommitIn|Area|Sel)\b/g) ?? []).length,
    effects: (s.match(/useEffect\(/g) ?? []).length,
  };
  controls.rawButtons += m.rawButtons;
  controls.rawFields += m.rawFields;
  controls.kit += m.kit;
  if (m.inner || m.service || m.view || m.changed || m.dom || m.contexts || m.letApp || m.lines > 400) rows.push(m);
}
rows.sort((a, b) => b.inner + b.view + b.service + b.changed - (a.inner + a.view + a.service + a.changed));
const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
const p = (n, w = 3) => String(n).padStart(w);
for (const r of rows) console.log(`${r.file.padEnd(52)} строк ${p(r.lines, 5)} · внутр.комп ${p(r.inner)} · состояние вида ${p(r.view)} · служебные ${p(r.service)} · changed ${p(r.changed)} · DOM ${p(r.dom)} · useState ${p(r.states)} · useEffect ${p(r.effects, 2)}`);
console.log("служебные ссылки:", Object.entries(services).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} ×${k}`).join(", "));
if (viewState.length) console.log("состояние вида:", viewState.join(", "));
console.log(`компоненты набора ${controls.kit} · <button> вне набора ${controls.rawButtons} · <input|textarea|select> вне набора ${controls.rawFields}`);
console.log(`ИТОГО: файлов ${rows.length} · внутренних компонентов ${sum("inner")} · createContext ${sum("contexts")} · let app ${sum("letApp")} · состояние вида в замыканиях ${sum("view")} · служебные ссылки ${sum("service")} · app.changed ${sum("changed")} · ручной DOM ${sum("dom")} · файлов > 400 строк ${rows.filter((r) => r.lines > 400).length}`);
