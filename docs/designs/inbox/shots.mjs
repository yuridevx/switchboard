// Снимки и жесты дизайна «Пост — очередь роли»: node docs/designs/inbox/shots.mjs [папка=shots] [адрес=http://localhost:4862]
// Настоящий экран «Фабрика» на моке флота: цех с постом на три сессии и тикетом, который сессия отложила, и страница
// этого тикета — на 1280 и 390, в светлой и тёмной теме. Потом жесты: на 1280 мышью, на 390 пальцем.
// Для страницы дизайна — дорожка поста и тело тикета крупно; места частей на снимках пишутся в страницу (блок zones в index.html).
// Страница: в web/ — npx vite --port 4862 --strictPort. Браузер — без окна.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const { chromium } = createRequire(path.join(root, "web", "package.json"))("playwright-core");
const out = path.join(here, process.argv[2] ?? "shots");
const base = process.argv[3] ?? "http://localhost:4862";
fs.mkdirSync(out, { recursive: true });

/** имя, путь, что должно появиться на экране */
const SCREENS = [
  ["floor", "/factory/infra", ".flane"],
  ["ticket", "/factory/infra/t/infra-55", ".fpath"],
];
const POOL = 'section[aria-label="Пост Кодеры служб"]';
/** части на снимке: имя → селекторы; рамка — общий прямоугольник всех найденных, в процентах снимка */
const ZONES = {
  lane: [POOL, {
    crew: [`${POOL} .fwho`], work: ['[data-ticket="infra-53"]', '[data-ticket="infra-54"]'], wait: ['[data-ticket="infra-55"]'],
    next: ['[data-ticket="infra-56"]'], queue: ['[data-ticket="infra-58"]'],
  }],
  ticket: [".stepbody", { state: [".fstate"], notes: [".fnotes"], act: [".fact"] }],
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
    const full = await page.evaluate(() => document.querySelector(".scroll")?.scrollHeight ?? 0);
    if (full > h) await page.setViewportSize({ width: w, height: full });
    await page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`) });
    n++;
    if (name === "floor") {
      // дорожка поста крупно — для страницы дизайна и телефона
      await page.locator(POOL).screenshot({ path: path.join(out, `lane-${w}-${theme}.png`) });
      n++;
      if (w === 1280 && theme === "light") zones.lane = await place(page, ZONES.lane);
    }
    if (name === "ticket" && w === 1280) {
      await page.locator(".stepbody").screenshot({ path: path.join(out, `ticket-body-${theme}.png`) });
      n++;
      if (theme === "light") zones.ticket = await place(page, ZONES.ticket);
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
  const step = async (label, fn) => {
    gestures++;
    try { await fn(); console.log(`✓ ${w} · ${label}`); }
    catch (e) { failed++; await page.screenshot({ path: path.join(out, `fail-${w}.png`) }); console.log(`✗ ${w} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  await step("лампа сессии поста открывает разговор этой сессии", async () => {
    await open("/factory/infra", POOL);
    await press(page.locator(`${POOL} .fcrew button[aria-label="coders-2@server"]`));
    await at("/work/coders-2@server");
  });
  const later = () => page.locator(".fstate .chip", { hasText: "через" });
  await step("заметка человека снимает отсрочку: тикет встаёт в очередь сразу", async () => {
    await open("/factory/infra/t/infra-55", '.fstate [data-state="ready"]');
    await later().waitFor();
    await page.getByLabel("Заметка").fill("Повторов — не больше двух за ночь.");
    await press(page.getByRole("button", { name: "Написать" }));
    await page.locator(".fnotes").getByText("Повторов — не больше двух за ночь.").waitFor();
    await later().waitFor({ state: "detached" });
  });
  await step("сданный тикет ложится итогом в тикет, с шага которого заведён, и снимает с него отсрочку", async () => {
    await open("/factory/infra/t/infra-57", '.fstate [data-state="work"]');
    await page.getByLabel("Заметка").fill("Два повтора: окно выгрузки сдвигается на 8 минут из 40.");
    await press(page.getByRole("button", { name: "Принять" }));
    await page.locator('.fstate [data-state="done"]').waitFor();
    await press(page.locator('[data-parent="infra-55"]'));
    await at("/factory/infra/t/infra-55");
    await page.locator(".fnotes").getByText("infra-57 сдан: Два повтора").waitFor();
    await later().waitFor({ state: "detached" });
  });
  await step("сессия поста освободилась — следующий тикет очереди берёт она", async () => {
    await open("/factory/infra/t/infra-53", '.fstate [data-state="work"]');
    await press(page.getByRole("button", { name: "Принять" }));
    await page.locator('.fstate [data-state="done"]').waitFor();
    await press(page.getByRole("button", { name: "Назад" }));
    await page.locator(`${POOL} [data-ticket="infra-58"].work`).waitFor();
    await page.locator(`${POOL} [data-ticket="infra-58"]`).getByText("coders", { exact: true }).waitFor();
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
} else fs.writeFileSync(path.join(out, "zones.json"), JSON.stringify(zones));
for (const p of problems) console.log(`✗ ${p}`);
console.log(`снимков ${n}, проблем ${problems.length} · жестов ${gestures - failed} из ${gestures}`);
process.exit(problems.length || failed ? 1 : 0);
