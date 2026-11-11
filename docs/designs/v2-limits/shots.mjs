// Снимки прототипа «Два запаса недели»: node docs/designs/v2-limits/shots.mjs [адрес=http://localhost:4836] [папка снимков]
// Настоящий Chrome на моке: экран аккаунтов — у аккаунта запасы Fable и остальных моделей, очередь следит за своим.
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
    try { await fn(); console.log(`✓ ${w} ${theme} · ${label}`); }
    catch (e) { bad++; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  const queue = (machine, name) => page.locator(".card").filter({ has: page.getByText(machine, { exact: true }) }).first().locator(`[data-queue="${name}"]`);
  const rows = (q, mail) => q.locator(`[data-drag-id$="|${mail}"] .meter-row`);

  await step("у аккаунта два запаса: Fable и остальные; очередь приглушает чужой", async () => {
    await page.goto(`${base}/#/fleet/accounts`);
    await queue("laptop", "main").waitFor();
    const fable = rows(queue("laptop", "main"), "yuri@example.com"), other = rows(queue("laptop", "review"), "yuri@example.com");
    if ((await fable.count()) !== 2) throw new Error("полосок не две");
    const cls = async (l, i) => (await l.nth(i).getAttribute("class")) ?? "";
    if (/off/.test(await cls(fable, 0)) || !/off/.test(await cls(fable, 1))) throw new Error("очередь fable должна приглушать «остальные»");
    if (!/off/.test(await cls(other, 0)) || /off/.test(await cls(other, 1))) throw new Error("очередь остальных должна приглушать Fable");
    await page.screenshot({ path: path.join(out, `accounts-${w}-${theme}.png`), fullPage: w < 500 });
  });
  await step("очередь остальных ждёт сброса, когда их запас исчерпан, хотя Fable ещё есть", async () => {
    const night = queue("server", "night");
    await night.scrollIntoViewIfNeeded();
    await night.screenshot({ path: path.join(out, `queue-${w}-${theme}.png`) });
  });
  await page.close();
}
await browser.close();
console.log(`${total - bad} из ${total}`);
process.exit(bad ? 1 : 0);
