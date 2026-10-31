// Сборка дизайна: части docs/design/parts/<вид>.html → docs/design.html, затем проверка в jsdom.
// Запуск: node docs/design/build.mjs (из любой папки). Падает с причиной — дизайн не собран.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "design.html");

// Вкладки верхней строки: тип модуля и имя; у вкладки с несколькими видами (sub) они — во второй строке
const TABS = [
  { tab: "eco", kind: "экосистема", name: "связи и доверие" },
  { tab: "workers", kind: "Cloudflare", name: "Workers", sub: "Worker-модули" },
  { tab: "keeper", kind: "ОС", name: "keeper" },
  { tab: "host", kind: "Claude SDK", name: "Host", sub: "модули Host" },
  { tab: "web", kind: "веб", name: "приложения", sub: "веб-приложения" },
];

// Виды по порядку; tab — вкладка верхней строки
export const VIEWS = [
  { id: "eco", tab: "eco", label: "связи и доверие" },
  { id: "relay", tab: "workers", label: "relay" },
  { id: "gate", tab: "workers", label: "gate" },
  { id: "push", tab: "workers", label: "push" },
  { id: "points", tab: "workers", label: "points" },
  { id: "ledger", tab: "workers", label: "ledger" },
  { id: "github", tab: "workers", label: "github" },
  { id: "keeper", tab: "keeper", label: "keeper" },
  { id: "host", tab: "host", label: "ядро" },
  { id: "host-fleet", tab: "host", label: "fleet" },
  { id: "host-questions", tab: "host", label: "questions" },
  { id: "host-push", tab: "host", label: "push" },
  { id: "host-watch", tab: "host", label: "watch" },
  { id: "host-chat", tab: "host", label: "chat" },
  { id: "host-manage", tab: "host", label: "manage" },
  { id: "host-slots", tab: "host", label: "slots" },
  { id: "host-accounts", tab: "host", label: "accounts" },
  { id: "host-profiles", tab: "host", label: "profiles" },
  { id: "host-points", tab: "host", label: "points" },
  { id: "host-remote", tab: "host", label: "remote" },
  { id: "host-machine", tab: "host", label: "machine" },
  { id: "host-upgrade", tab: "host", label: "upgrade" },
  { id: "host-journal", tab: "host", label: "journal" },
  { id: "phone", tab: "web", label: "телефон" },
  { id: "panel", tab: "web", label: "пульт: сессии и чат" },
  { id: "panel-fleet", tab: "web", label: "пульт: флот" },
];

function fail(msg) {
  console.error("build: " + msg);
  process.exit(1);
}

function nav() {
  const tabs = TABS.map((t) => {
    const first = VIEWS.find((v) => v.tab === t.tab);
    if (!first) fail(`у вкладки ${t.tab} нет видов`);
    return `<a class="nav-tab" href="#${first.id}" data-tab="${t.tab}"><small>${t.kind}</small><b>${t.name}</b></a>`;
  });
  const subs = TABS.filter((t) => t.sub).map((t) => {
    const items = VIEWS.filter((v) => v.tab === t.tab).map((v) => `<a href="#${v.id}" data-nav="${v.id}">${v.label}</a>`);
    return `<div class="nav-row nav-sub" data-sub="${t.tab}" hidden><span class="lbl">${t.sub}</span>${items.join("")}</div>`;
  });
  return `<nav class="nav" aria-label="Части дизайна">
<div class="nav-row">${tabs.join("")}</div>
${subs.join("\n")}
</nav>`;
}

const ROUTER = `<script>
/* ===== Виды: показывается тот, что в #хэше; по умолчанию — экосистема ===== */
(function(){
  const TAB_OF = ${JSON.stringify(Object.fromEntries(VIEWS.map((v) => [v.id, v.tab])))};
  const HAS_SUB = ${JSON.stringify(TABS.filter((t) => t.sub).map((t) => t.tab))};
  function show(){
    const want = location.hash.slice(1);
    const views = document.querySelectorAll(".view[data-view]");
    let id = "eco";
    views.forEach(v => { if (v.dataset.view === want) id = want; });
    views.forEach(v => { v.hidden = v.dataset.view !== id; });
    const tab = TAB_OF[id];
    document.querySelectorAll("[data-tab]").forEach(a => {
      const on = a.dataset.tab === tab;
      a.classList.toggle("on", on);
      if (on && a.scrollIntoView) a.scrollIntoView({block:"nearest", inline:"center"});
      if (on && !HAS_SUB.includes(tab)) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-sub]").forEach(r => { r.hidden = r.dataset.sub !== tab; });
    document.querySelectorAll("[data-nav]").forEach(a => {
      if (a.dataset.nav === id){ a.setAttribute("aria-current", "page"); a.scrollIntoView && a.scrollIntoView({block:"nearest", inline:"center"}); }
      else a.removeAttribute("aria-current");
    });
    document.dispatchEvent(new CustomEvent("view:show", { detail: id }));
  }
  window.addEventListener("hashchange", () => { show(); window.scrollTo(0, 0); });
  show();
})();
</script>`;

const parts = VIEWS.map((v) => {
  const p = join(here, "parts", v.id + ".html");
  if (!existsSync(p)) fail(`нет части ${v.id}: ${p}`);
  return `<div class="view" data-view="${v.id}" id="v-${v.id}">\n${readFileSync(p, "utf8")}\n</div>`;
});

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Switchboard</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600&family=JetBrains+Mono:wght@400;600&family=Unbounded:wght@500;700&display=swap">
<style>
  /* сброс: отступы под вырезы телефона, скрытое — скрыто */
  :root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
  body{margin:0}
  img{max-width:100%}
  [hidden]{display:none!important}
${readFileSync(join(here, "style.css"), "utf8")}
</style>
</head>
<body>

<div class="wrap">
${nav()}
${parts.join("\n\n")}
<footer>Switchboard · дизайн экосистемы модулей и сервисов.</footer>
</div>

${ROUTER}

<script>
${readFileSync(join(here, "marks.js"), "utf8")}
</script>
</body>
</html>
`;

writeFileSync(out, html);

// ===== Проверка: скрипты без ошибок, id и data-chg не повторяются, у каждого вида есть блоки =====
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("скрипт: " + (e.message || e)));
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  url: "https://example.invalid/",
  // в jsdom нет прокрутки — заглушка, чтобы роутер не сыпал «Not implemented»
  beforeParse(w) { w.scrollTo = () => {}; },
});
const doc = dom.window.document;
// каждый вид показать хотя бы раз — скрипты, что рисуют по view:show, тоже прогоняются
for (const v of VIEWS) {
  dom.window.location.hash = v.id;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
}
const dup = (attr) => {
  const seen = new Map();
  doc.querySelectorAll(`[${attr}]`).forEach((n) => {
    const k = n.getAttribute(attr);
    seen.set(k, (seen.get(k) || 0) + 1);
  });
  return [...seen].filter(([, c]) => c > 1).map(([k, c]) => `${attr}="${k}" ×${c}`);
};
errors.push(...dup("id"), ...dup("data-chg"));
for (const v of VIEWS) {
  const n = doc.querySelectorAll(`.view[data-view="${v.id}"] [data-chg]`).length;
  if (!n) errors.push(`вид ${v.id}: нет блоков data-chg`);
}
doc.querySelectorAll('a[href^="#"]').forEach((a) => {
  const t = a.getAttribute("href").slice(1);
  if (t && !VIEWS.some((v) => v.id === t) && !doc.getElementById(t)) errors.push(`ссылка #${t} никуда не ведёт`);
});
if (errors.length) fail(errors.length + " ошибок:\n" + errors.join("\n"));
console.log(`build: ok · ${VIEWS.length} видов · ${doc.querySelectorAll("[data-chg]").length} блоков · ${Buffer.byteLength(html)} байт`);

// --fragment <файл>: копия без каркаса страницы — публикация сама оборачивает её в свой
const fi = process.argv.indexOf("--fragment");
if (fi > 0) {
  const target = process.argv[fi + 1];
  if (!target) fail("--fragment: нет пути");
  const frag = html
    .replace(/^<!DOCTYPE html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport"[^\n]*\n/, "")
    .replace("</head>\n<body>\n", "")
    .replace(/<\/body>\n<\/html>\n$/, "");
  if (/<!DOCTYPE|<\/?html[\s>]|<\/?body>|<\/?head>/i.test(frag)) fail("--fragment: каркас не снят");
  writeFileSync(target, frag);
  console.log(`fragment: ${target} · ${Buffer.byteLength(frag)} байт`);
}
