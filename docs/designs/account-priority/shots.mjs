// Снимки и жесты дизайна «Рычаг аккаунта»: node docs/designs/account-priority/shots.mjs [папка=shots] [адрес=http://localhost:4871]
// Настоящий экран «Флот → Аккаунты» на моке флота (из web/: npx vite --port 4871 --strictPort): рычаг аккаунта Claude из трёх положений —
// выключен, по счёту, первым. На 1280 — мышью, на 390 — пальцем; светлая и тёмная тема.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../../tools/fleet/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, process.argv[2] ?? "shots");
const base = process.argv[3] ?? "http://localhost:4871";
fs.mkdirSync(out, { recursive: true });

const browser = await launchBrowser();
let bad = 0, total = 0;
/** Места частей на снимке для страницы дизайна: имя → селекторы внутри карточки; рамка — общий прямоугольник найденных, в процентах карточки. */
const ZONES = {
  lever: ['[data-account="ops@example.com"] .uselever'], offcol: ['[data-account="ops@example.com"] .acol-bars', '[data-account="ops@example.com"] .acol-left'],
  dots: ['[data-account="ops@example.com"] .sdots'], first: ['[data-account="night@example.com"] .uselever'], feed: [".moves .line:nth-child(-n+4)"],
};
const zones = {};
for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
  const wide = w > 860;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: theme, locale: "ru-RU", hasTouch: !wide });
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const card = page.locator('[data-card="claude"]');
  const col = (name) => card.locator(`[data-account="${name}@example.com"]`);
  const lever = (name, word) => col(name).getByRole("radio", { name: word });
  /** Нажатие: на широком экране — мышью, на телефоне — пальцем. */
  const press = (loc) => (wide ? loc.click() : loc.tap());
  const order = () => card.locator("[data-account]").evaluateAll((els) => els.map((e) => e.getAttribute("data-account").split("@")[0]));
  const shot = async (name) => {
    await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
    // подсказка последнего нажатия на снимок не попадает
    await page.mouse.move(0, 0);
    await card.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`) });
  };
  const step = async (label, fn) => {
    total++;
    try {
      await fn();
      if (errors.length) throw new Error("ошибка страницы: " + errors.splice(0).join(" | "));
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) throw new Error(`горизонтальная прокрутка ${over}px`);
      console.log(`✓ ${w} ${theme} · ${label}`);
    } catch (e) {
      bad++;
      errors.length = 0;
      await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) });
      console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`);
    }
  };
  const same = (got, want, what) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: ${got.join(" ")} вместо ${want.join(" ")}`); };

  const ORDER = ["anya", "ops", "yuri", "night", "work", "team"];
  await step("у годного аккаунта рычаг из трёх положений, у негодного токена рычага нет", async () => {
    await page.goto(`${base}/?mock&still#/fleet/accounts`);
    await page.reload();
    await col("night").waitFor();
    if ((await col("ops").getByRole("radio").count()) !== 3) throw new Error("у ops не три положения");
    if (await col("team").getByRole("radiogroup").count()) throw new Error("у негодного токена есть рычаг");
    if ((await lever("night", "Первым").getAttribute("aria-checked")) !== "true") throw new Error("night не «первым»");
    same(await order(), ORDER, "порядок столбцов");
    // рычаги всех столбцов — на одной высоте
    const tops = await card.locator(".uselever").evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
    if (wide && tops.length !== 1) throw new Error(`рычаги на разной высоте: ${tops.join(", ")}`);
    await shot("accounts");
  });

  await step("«Выключен» у ops: столбец гаснет на своём месте, занятые сессии уходят на другой аккаунт, спящие остаются привязаны; в ленте — кто выключил и переходы", async () => {
    const busy = await col("ops").locator(".sdots .lamp.busy").count(), all = await col("ops").locator(".sdots .lamp").count();
    if (!busy || busy === all) throw new Error(`у ops до выключения нужны и занятые, и спящие сессии: ${busy} из ${all}`);
    await press(lever("ops", "Выключен"));
    await card.locator('[data-account="ops@example.com"].off').waitFor();
    if (await col("ops").locator(".sdots .lamp.busy").count()) throw new Error("на выключенном аккаунте остались занятые сессии");
    if ((await col("ops").locator(".sdots .lamp").count()) !== all - busy) throw new Error("спящие сессии выключенного аккаунта пропали");
    same(await order(), ORDER, "порядок столбцов");
    await card.locator(".moves").getByText("ops: выключен").waitFor();
    await card.locator(".moves").getByText("аккаунт выключен").first().waitFor();
    await shot("accounts-off");
    if (wide && theme === "light") zones.off = await card.evaluate((root, map) => {
      const base = root.getBoundingClientRect(), pct = (v, of) => Math.round((v / of) * 1000) / 10;
      return Object.fromEntries(Object.entries(map).map(([name, sels]) => {
        const rects = sels.flatMap((s) => [...root.querySelectorAll(s)]).map((el) => el.getBoundingClientRect());
        if (!rects.length) throw new Error("части «" + name + "» на экране нет");
        const l = Math.min(...rects.map((r) => r.left)) - 4, t = Math.min(...rects.map((r) => r.top)) - 4, r = Math.max(...rects.map((x) => x.right)) + 4, b = Math.max(...rects.map((x) => x.bottom)) + 4;
        return [name, { left: pct(l - base.left, base.width), top: pct(t - base.top, base.height), width: pct(r - l, base.width), height: pct(b - t, base.height) }];
      }));
    }, ZONES);
  });

  await step("«По счёту» у ops: столбец снова в цвете, спящие сессии остались на нём", async () => {
    await press(lever("ops", "По счёту"));
    await card.locator('[data-account="ops@example.com"]:not(.off)').waitFor();
    if (!(await col("ops").locator(".sdots .lamp").count())) throw new Error("спящие сессии не остались на аккаунте");
    await card.locator(".moves").getByText("ops: по счёту").waitFor();
  });

  await step("«Первым» у yuri: рычаг горит, столбцы стоят как стояли", async () => {
    await press(lever("yuri", "Первым"));
    await card.locator('[data-account="yuri@example.com"].first').waitFor();
    same(await order(), ORDER, "порядок столбцов");
    await card.locator(".moves").getByText("yuri: первым").waitFor();
    await shot("accounts-first");
  });

  await page.close();
}
await browser.close();
// рамки на снимке страницы дизайна стоят по настоящей разметке экрана
if (zones.off) {
  const file = path.join(here, "index.html"), html = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, html.replace(/(<script type="application\/json" id="zones">)[^<]*(<\/script>)/, (_, a, b) => a + JSON.stringify(zones) + b));
}
console.log(`\n${total - bad} из ${total}`);
process.exit(bad ? 1 : 0);
