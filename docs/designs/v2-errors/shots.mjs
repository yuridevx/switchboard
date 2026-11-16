// Снимки прототипа «Ошибки на виду»: лента сессии с бедами — 1280 и 390, светлая и тёмная тема.
// node docs/designs/v2-errors/shots.mjs [адрес страницы на моке]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../../tools/fleet/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? "http://127.0.0.1:5391";
const out = path.join(here, "shots");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
for (const [w, h] of [[1280, 860], [390, 844]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 2, hasTouch: w < 500, isMobile: w < 500 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/?mock&still#/work/cipher@server`);
    await page.waitForSelector(".sysline.tone-bad", { timeout: 15_000 });
    await page.waitForTimeout(800);
    const rows = await page.locator(".sysline.tone-bad, .sysline.tone-wait").allInnerTexts();
    const toasts = await page.locator(".banner.bad").allInnerTexts();
    await page.screenshot({ path: path.join(out, `feed-${w}-${scheme}.png`) });
    console.log(`${w} ${scheme}: строк беды ${rows.length}, строк полосы ${toasts.length}, ошибок страницы ${errors.length}`);
    if (w === 1280 && scheme === "light") console.log(JSON.stringify({ rows, toasts }, null, 1));
    await ctx.close();
  }
}
await browser.close();
