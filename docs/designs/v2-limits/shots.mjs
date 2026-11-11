// Снимки прототипа «Одна очередь, два места»: node docs/designs/v2-limits/shots.mjs [адрес=http://localhost:4836] [папка снимков]
// Настоящий Chrome на моке: очередь без вида, у аккаунта неделя в два тона и Fable, лампы двух мест, перестановка места лампой.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../v2");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
const base = process.argv[2] ?? "http://localhost:4836";
const out = process.argv[3] ?? path.join(here, "shots");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
let bad = 0, total = 0;
for (const [w, h] of [[1280, 860], [390, 844]]) for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: w < 500 });
  page.setDefaultTimeout(9000);
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const step = async (label, fn) => {
    total++;
    try {
      await fn();
      const over = await page.locator(".mantine-Modal-root:visible, .mantine-Drawer-root:visible").count();
      if (over) throw new Error("окно поверх экрана");
      console.log(`✓ ${w} ${theme} · ${label}`);
    } catch (e) { bad++; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  const queue = (machine, name) => page.locator(".card").filter({ has: page.getByText(machine, { exact: true }) }).first().locator(`[data-queue="${name}"]`);
  const line = (q, mail) => q.locator(`[data-drag-id$="|${mail}"]`);
  const stands = async (q, lane) => q.locator(`.lamp.idle[data-lane="${lane}"]`).evaluateAll((els) => els.map((e) => e.closest("[data-drag-id]").dataset.dragId.split("|")[1]));

  await step("очередь без вида: один порядок, Fable и остальные модели стоят на разных аккаунтах", async () => {
    await page.goto(`${base}/#/fleet/accounts`);
    const main = queue("laptop", "main");
    await main.waitFor();
    if (await page.locator('[aria-label^="Модель очереди"]').count()) throw new Error("у очереди остался выбор вида");
    const f = await stands(main, "fable"), o = await stands(main, "other");
    if (f.join() !== "yuri@example.com" || o.join() !== "work@example.com") throw new Error(`места: Fable ${f}, остальные ${o}`);
    await page.screenshot({ path: path.join(out, `accounts-${w}-${theme}.png`), fullPage: w < 500 });
  });

  await step("неделя в два тона, как у Claude: доля Fable, остальные и запас для Fable; числа — неделя 47, Fable 74", async () => {
    const yuri = line(queue("laptop", "main"), "yuri@example.com");
    const week = yuri.locator(".meter-row").nth(0), fable = yuri.locator(".meter-row").nth(1);
    if ((await week.locator("b").textContent()) !== "47" || (await fable.locator("b").textContent()) !== "74") throw new Error("числа не те");
    const parts = await week.locator(".meter-bar i").evaluateAll((els) => els.map((e) => `${e.className || "rest"}:${e.style.width}`));
    if (parts.join() !== "share:37%,rest:10%,hold:13%") throw new Error("полоска недели: " + parts.join());
  });

  await step("Fable выбран на всех аккаунтах очереди — место Fable ждёт сброса, остальные работают", async () => {
    const review = queue("laptop", "review");
    await review.locator('[data-chip="fable-wait"]').waitFor();
    if ((await stands(review, "fable")).length || (await stands(review, "other")).join() !== "work@example.com") throw new Error("места review не те");
  });

  await step("остальные выбрали свою половину на всех аккаунтах — идут из запаса Fable", async () => {
    const q = queue("anya-pc", "main");
    await q.locator('[data-chip="over"]').waitFor();
    await q.scrollIntoViewIfNeeded();
    await q.screenshot({ path: path.join(out, `over-${w}-${theme}.png`) });
  });

  await step("лампа у полоски Fable ставит место Fable на другой аккаунт; место остальных не двигается", async () => {
    const main = queue("server", "main");
    await line(main, "ops@example.com").locator('button.lamp[data-lane="fable"]').click();
    await page.waitForFunction(() => document.querySelector('[data-drag-id="main|ops@example.com"] .lamp.idle[data-lane="fable"]'));
    if ((await stands(main, "other")).join() !== "yuri@example.com") throw new Error("место остальных сдвинулось");
    await main.scrollIntoViewIfNeeded();
    await main.screenshot({ path: path.join(out, `put-${w}-${theme}.png`) });
  });

  await step("новая сессия: очередь не ограничивает модели", async () => {
    await page.goto(`${base}/#/new`);
    const model = page.getByLabel("Модель", { exact: true }).first();
    await model.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await model.click();
    await page.getByRole("option", { name: /fable/i }).first().waitFor();
    await page.getByRole("option", { name: /opus/i }).first().waitFor();
    await page.keyboard.press("Escape");
  });
  await page.close();
}
await browser.close();
console.log(`${total - bad} из ${total}`);
process.exit(bad ? 1 : 0);
