// Снимки «Память флота»: node docs/designs/memory/shots.mjs [папка=shots] [адрес=http://127.0.0.1:4881]
// Настоящая вкладка «Память» набора кусочков на моке: мера индекса приходит от машины готовой — строки, байты и пределы; своих чисел у страницы нет.
// На 1280 жесты — мышью, на 390 — пальцем. Страница на моке: из web/ — npx vite --port 4881 --strictPort --host 127.0.0.1
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../../tools/fleet/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, process.argv[2] ?? "shots");
const base = process.argv[3] ?? "http://127.0.0.1:4881";
fs.mkdirSync(out, { recursive: true });

const MEASURE = "66 из 200 строк · 12,1 из 25 КБ";
const browser = await launchBrowser();
let bad = 0, total = 0;
for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
  const wide = w > 860;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: !wide });
  page.setDefaultTimeout(9000);
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const press = (loc) => (wide ? loc.click() : loc.tap());
  const step = async (label, fn) => {
    total++;
    try { await fn(); console.log(`✓ ${w} ${theme} · ${label}`); }
    catch (e) { bad++; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  await step("вкладка «Память» набора показывает меру индекса числами машины", async () => {
    await page.goto(`${base}/?mock&still#/fleet/profiles`);
    await page.reload();
    await page.getByText("Основа").first().waitFor();
    // на телефоне просмотр набора открывается своим шагом
    if (!wide) await press(page.getByRole("button", { name: "Что в наборе" }));
    await press(page.getByRole("tab", { name: "Память" }));
    await page.getByText(MEASURE).first().waitFor();
    const wider = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (wider) throw new Error("страница шире окна");
    await page.screenshot({ path: path.join(out, `memory-${w}-${theme}.png`) });
  });
  await page.close();
}
await browser.close();
console.log(bad ? `сбоев: ${bad} из ${total}` : `снимки сняты: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
