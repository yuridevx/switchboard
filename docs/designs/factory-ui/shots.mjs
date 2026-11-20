// Снимки и жесты «Фабрика: экран заново»: node docs/designs/factory-ui/shots.mjs [папка=shots] [адрес=http://localhost:4861]
// Настоящий экран «Фабрика» на моке флота: цех двух фабрик (плотной и редкой на паузе), вкладки «Бэклог» и «Входы», тикет,
// вставший тикет и новый тикет — на 1280 и 390, в светлой и тёмной теме. Потом жесты: на 1280 мышью, на 390 пальцем.
// Для страницы дизайна — ещё экран целиком, дорожка конвейера и тело тикета крупно; места частей на этих снимках пишутся
// прямо в страницу (блок zones в index.html): рамки на ней стоят по настоящей разметке.
// Страница: в web/ — npx vite --port 4861 --strictPort. Браузер — без окна: на Windows настоящий Chrome на свежем профиле запирает вход в систему.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const { chromium } = createRequire(path.join(root, "web", "package.json"))("playwright-core");
const out = path.join(here, process.argv[2] ?? "shots");
const base = process.argv[3] ?? "http://localhost:4861";
fs.mkdirSync(out, { recursive: true });

/** имя, путь, что должно появиться на экране */
const SCREENS = [
  ["factory", "/factory/infra", ".flane"],
  ["factory-sparse", "/factory/research", ".flane"],
  ["backlog", "/factory/infra/backlog", ".frow"],
  ["inputs", "/factory/infra/inputs", "[data-on]"],
  ["ticket", "/factory/infra/t/infra-41", ".fpath"],
  ["ticket-stop", "/factory/infra/t/infra-39", ".fpath"],
  ["new", "/factory/infra/new", "input"],
];
const LANE = 'section[aria-label="Конвейер Изменение службы"]';
/** части на снимке: имя → селекторы; рамка — общий прямоугольник всех найденных, в процентах снимка */
const ZONES = {
  factory: [".page.factory", {
    head: [".fhead"], tabs: [".ftabs"], call: [".fcall"], lines: ['.flane[aria-label^="Конвейер"]'], posts: ['.flane[aria-label^="Пост"]'], sessions: ['.flane[aria-label^="Сессия"]'],
  }],
  lane: [LANE, {
    slots: [`${LANE} .fslots`], rail: [`${LANE} .fstop-head`], work: ['[data-ticket="infra-43"]'], ready: ['[data-ticket="infra-45"]'],
    human: [`${LANE} [data-ticket="infra-41"]`], stop: [`${LANE} [data-ticket="infra-39"]`], event: ['[data-ticket="infra-36"]'],
  }],
  sparse: [".page.factory", { paused: [".fhead"], idle: ['[aria-label="Свободные посты"]'], queue: ['.flane[aria-label^="Пост"]'] }],
  backlog: [".page.factory", { todo: ['section[aria-label="Бэклог"]'], done: ['section[aria-label="Закрытые"]'] }],
  inputs: [".page.factory", { timed: ['[data-on="disk"]'], cron: ['[data-on="retro"]'], hook: ['[data-on="alerts"]'], named: ['[data-on="model"]'] }],
  ticket: [".stepbody", { path: [".fpath"], state: [".fstate"], notes: [".fnotes"], act: [".fact"] }],
};
const zones = {};
/** Места частей внутри корня — в процентах его размеров. */
const place = (page, [rootSel, map]) => page.evaluate(([rootSel, map]) => {
  const base = document.querySelector(rootSel).getBoundingClientRect();
  const pct = (v, of) => Math.round((v / of) * 1000) / 10;
  return Object.fromEntries(Object.entries(map).map(([name, sels]) => {
    const rects = sels.flatMap((s) => [...document.querySelectorAll(s)]).map((el) => el.getBoundingClientRect());
    if (!rects.length) throw new Error(`части «${name}» на экране нет`);
    const l = Math.min(...rects.map((r) => r.left)), t = Math.min(...rects.map((r) => r.top)), r = Math.max(...rects.map((x) => x.right)), b = Math.max(...rects.map((x) => x.bottom));
    return [name, { left: pct(l - base.left, base.width), top: pct(t - base.top, base.height), width: pct(r - l, base.width), height: pct(b - t, base.height) }];
  }));
}, [rootSel, map]);
/** Шрифты загружены и кадр отрисован: снимок не ловит подмену шрифта. */
const settled = (page) => page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));

const browser = await chromium.launch();
const problems = [];
let n = 0;
for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: theme, locale: "ru-RU", hasTouch: w < 860 });
  await ctx.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  for (const [name, route, ready] of SCREENS) {
    const page = await ctx.newPage();
    const at = `${name} ${w} ${theme}`;
    page.on("pageerror", (e) => problems.push(`${at}: ${e.message}`));
    await page.goto(`${base}/?still#${route}`);
    await page.locator(ready).first().waitFor().catch(() => problems.push(`${at}: экран не открылся`));
    await settled(page);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 0) problems.push(`${at}: горизонтальная прокрутка ${over}px`);
    const inner = await page.evaluate(() => [...document.querySelectorAll(".page *")].filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)).length);
    if (inner) problems.push(`${at}: вбок едет блоков: ${inner}`);
    await page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`) });
    n++;
    // для страницы дизайна: экран целиком и части крупно — в светлой теме
    if (theme === "light") {
      const full = await page.evaluate(() => document.querySelector(".scroll")?.scrollHeight ?? 0);
      if (full > h) await page.setViewportSize({ width: w, height: full });
      if (["factory", "factory-sparse", "backlog", "inputs"].includes(name)) {
        await page.locator(".page.factory").screenshot({ path: path.join(out, `${name}-${w}-page.png`) });
        n++;
      }
      if (w === 1280 && name === "factory") {
        zones.factory = await place(page, ZONES.factory);
        await page.locator(LANE).screenshot({ path: path.join(out, "lane.png") });
        zones.lane = await place(page, ZONES.lane);
        n++;
      }
      if (w === 1280 && name === "factory-sparse") zones.sparse = await place(page, ZONES.sparse);
      if (w === 1280 && (name === "backlog" || name === "inputs")) zones[name] = await place(page, ZONES[name]);
      if (w === 1280 && name === "ticket") {
        await page.locator(".stepbody").screenshot({ path: path.join(out, "ticket-body.png") });
        zones.ticket = await place(page, ZONES.ticket);
        n++;
      }
    }
    await page.close();
  }
  await ctx.close();
}

/* ===== Жесты: на 1280 — мышью, на 390 — пальцем. Каждый шаг ждёт то, что должно появиться на экране. ===== */
let gestures = 0, failed = 0;
for (const [w, h] of [[1280, 900], [390, 844]]) {
  const wide = w > 860;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: "ru-RU", hasTouch: !wide });
  const page = await ctx.newPage();
  page.setDefaultTimeout(9000);
  const press = (loc) => (wide ? loc.click() : loc.tap());
  const open = async (route, ready) => { await page.goto(`${base}/?still#${route}`); await page.reload(); await page.locator(ready).first().waitFor(); };
  const at = (hash) => page.waitForFunction((want) => decodeURIComponent(location.hash) === want, `#${hash}`);
  const gone = (sel) => page.waitForFunction((s) => !document.querySelector(s), sel);
  const step = async (label, fn) => {
    gestures++;
    try { await fn(); console.log(`✓ ${w} · ${label}`); }
    catch (e) { failed++; await page.screenshot({ path: path.join(out, `fail-${w}.png`) }); console.log(`✗ ${w} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  await step("вкладка «Бэклог» открывается нажатием и получает свой адрес; «Цех» возвращает дорожки", async () => {
    await open("/factory/infra", ".flane");
    await press(page.getByRole("tab", { name: "Бэклог" }));
    await at("/factory/infra/backlog");
    await page.locator('section[aria-label="Бэклог"] [data-ticket="infra-50"]').waitFor();
    await press(page.getByRole("tab", { name: "Цех" }));
    await at("/factory/infra");
    await page.locator(".flane").first().waitFor();
  });
  await step("плашка открывает тикет; «Принять» двигает его на следующую станцию; «Назад» возвращает в цех, из первого блока тикет ушёл", async () => {
    await open("/factory/infra", ".flane");
    await press(page.locator(`${LANE} [data-ticket="infra-41"]`));
    await at("/factory/infra/t/infra-41");
    await press(page.getByRole("button", { name: "Принять" }));
    await page.locator('.fpath [aria-current="step"]', { hasText: "правка" }).waitFor();
    await press(page.getByRole("button", { name: "Назад" }));
    await page.locator(`${LANE} [aria-label="Шаг правка"] [data-ticket="infra-41"]`).waitFor();
    await gone('.fcall [data-ticket="infra-41"]');
  });
  await step("строка первого блока открывает вставший тикет; «Вернуть в очередь» убирает его из блока", async () => {
    await open("/factory/infra", ".fcall");
    await press(page.locator('.fcall [data-ticket="infra-39"]'));
    await at("/factory/infra/t/infra-39");
    await press(page.getByRole("button", { name: "Вернуть в очередь" }));
    await page.locator('.fstate [data-state]:not([data-state="stop"])').waitFor();
    await press(page.getByRole("button", { name: "Назад" }));
    await page.locator(`${LANE} [data-ticket="infra-39"]`).waitFor();
    await gone('.fcall [data-ticket="infra-39"]');
  });
  await step("метка свободного поста открывает разговор его сессии", async () => {
    await open("/factory/research", '[aria-label="Свободные посты"]');
    await press(page.locator('[aria-label="Свободные посты"] [data-post="lead"]'));
    await at("/work/lead@laptop");
  });
  await step("вкладка «Входы»: тикет, который вход держит открытым, открывается из его строки", async () => {
    await open("/factory/infra/inputs", "[data-on]");
    await press(page.locator('[data-on="disk"] [data-ticket="infra-49"]'));
    await at("/factory/infra/t/infra-49");
    await page.locator(".fpath").waitFor();
  });
  await step("новый тикет без исполнителя возвращает экран во вкладку «Бэклог», и тикет в ней стоит", async () => {
    await open("/factory/infra", ".flane");
    await press(page.getByRole("button", { name: "Тикет" }));
    await at("/factory/infra/new");
    await page.getByLabel("Заголовок").fill("Сверить права архива");
    await press(page.getByRole("button", { name: "Создать" }));
    await at("/factory/infra/backlog");
    await page.locator('section[aria-label="Бэклог"]').getByText("Сверить права архива").waitFor();
  });
  await ctx.close();
}
await browser.close();

// страница дизайна ставит рамки по этим местам: блок с ними переписывается вместе со снимками
const doc = path.join(here, "index.html");
if (out === path.join(here, "shots") && fs.existsSync(doc)) {
  const html = fs.readFileSync(doc, "utf8");
  const open = '<script type="application/json" id="zones">';
  const from = html.indexOf(open), to = html.indexOf("</script>", from);
  if (from < 0) problems.push("в index.html нет блока zones");
  else fs.writeFileSync(doc, html.slice(0, from + open.length) + JSON.stringify(zones) + html.slice(to));
}
for (const p of problems) console.log(`✗ ${p}`);
console.log(`снимков ${n}, проблем ${problems.length} · жестов ${gestures - failed} из ${gestures}`);
process.exit(problems.length || failed ? 1 : 0);
