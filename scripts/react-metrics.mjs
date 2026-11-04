// Числа идиоматичности React-кода фронта. node scripts/react-metrics.mjs
// Считаются только `let`, Map и Set на отступе 2 внутри фабрик create*: локальные переменные функций верхнего уровня не состояние модуля.
// Служебные ссылки — что не рисуется: app, снимок и его хранилище, клиент настроек, циклы опроса машин, таймеры и счётчики ядра, защита от устаревшего ответа.
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

/** Что служебное и почему. */
const SERVICE = {
  app: "app модуля",
  p: "клиент настроек",
  user: "клиент настроек",
  fleet: "клиент настроек",
  accs: "цикл опроса машин",
  slots: "цикл опроса машин",
  replies: "цикл опроса машин",
  keeper: "цикл опроса машин",
  state: "сам снимок",
  subs: "подписчики выборок",
  rev: "номер уведомления",
  queued: "уведомление в такте",
  lk: "соединение",
  pause: "пауза переподключения",
  pending: "начатые запросы",
  hidden: "страница скрыта",
  life: "очередь ухода и возврата",
  routed: "адрес маршрута",
  depth: "глубина истории",
  epoch: "защита от устаревшего ответа",
  listening: "слушатель обработчика пушей",
  timer: "таймер",
  frameOwner: "реестр модулей",
  screenOwner: "реестр модулей",
  markOwner: "реестр модулей",
  opened: "открытая база",
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
const services = {};
const viewState = [];
for (const f of walk(join(root, "web"))) {
  const s = readFileSync(f, "utf8");
  const lines = s.split("\n");
  const file = relative(root, f).replaceAll("\\", "/");
  const names = inFactories(lines);
  const view = names.filter((n) => !(n in SERVICE));
  for (const n of names) if (n in SERVICE) services[n] = (services[n] ?? 0) + 1;
  for (const n of view) viewState.push(`${file}: ${n}`);
  const m = {
    file,
    lines: lines.length,
    // компонент (function с заглавной) с отступом: объявлен внутри другой функции
    inner: lines.filter((l) => /^\s+(const \w+ = memo\(function |function )[A-Z]\w*\(/.test(l)).length,
    service: names.length - view.length,
    view: view.length,
    changed: (s.match(/app\.changed\(\)/g) ?? []).length,
    dom: (s.match(/\.querySelector|document\.getElementById|\.value = |\.classList\.|\.style\.\w+ = /g) ?? []).length,
    states: (s.match(/useState[<(]/g) ?? []).length,
    effects: (s.match(/useEffect\(/g) ?? []).length,
  };
  if (m.inner || m.service || m.view || m.changed || m.dom || m.lines > 400) rows.push(m);
}
rows.sort((a, b) => b.inner + b.view + b.service + b.changed - (a.inner + a.view + a.service + a.changed));
const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
const p = (n, w = 3) => String(n).padStart(w);
for (const r of rows) console.log(`${r.file.padEnd(52)} строк ${p(r.lines, 5)} · внутр.комп ${p(r.inner)} · состояние вида ${p(r.view)} · служебные ${p(r.service)} · changed ${p(r.changed)} · DOM ${p(r.dom)} · useState ${p(r.states)} · useEffect ${p(r.effects, 2)}`);
console.log("служебные ссылки:", Object.entries(services).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} ×${k} (${SERVICE[n]})`).join(", "));
if (viewState.length) console.log("состояние вида:", viewState.join(", "));
console.log(`ИТОГО: файлов ${rows.length} · внутренних компонентов ${sum("inner")} · состояние вида в замыканиях ${sum("view")} · служебные ссылки ${sum("service")} · app.changed ${sum("changed")} · ручной DOM ${sum("dom")} · файлов > 400 строк ${rows.filter((r) => r.lines > 400).length}`);
