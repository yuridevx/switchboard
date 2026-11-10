// Снимки прототипа «Откат и ведомый»: node docs/designs/v2-rewind/shots.mjs [адрес=http://localhost:4831]
// Проходит сценарии в настоящем Chrome на моке: шаг отката, разговоры папки в форме, вести ведомого у ведущего, ряд под полем ввода, карточка разрешения.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../v2");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
const base = process.argv[2] ?? "http://localhost:4831";
const out = path.join(here, "shots");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
let bad = 0;
for (const [w, h] of [[1280, 860], [390, 844]]) for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(9000);
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`) });
  const open = async (hash) => { await page.goto(`${base}/#${hash}`); await page.waitForTimeout(700); };
  const step = async (label, fn) => { try { await fn(); console.log(`✓ ${w} ${theme} · ${label}`); } catch (e) { bad++; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); } };

  await step("разговоры папки в форме", async () => {
    await open("/new?machine=laptop&cwd=~/projects/site");
    const list = page.getByRole("listbox", { name: "Разговоры папки" });
    await list.waitFor({ timeout: 10_000 });
    await list.getByRole("option").nth(1).click();
    await list.scrollIntoViewIfNeeded();
    await shot("conversations");
  });
  await step("шаг отката: разговор и файлы", async () => {
    await open("/work/site@laptop");
    await page.getByRole("button", { name: "Откатить сюда" }).last().click();
    await page.waitForFunction(() => /do=rewind/.test(location.hash));
    await page.getByText("Разговор и файлы", { exact: true }).click();
    await page.locator('[data-step="rewind"]').getByText("src/components/Header.tsx").waitFor();
    await shot("rewind");
    await page.getByRole("button", { name: "Откатить", exact: true }).click();
    await page.waitForFunction(() => !/do=rewind/.test(location.hash));
    // текст ушедшего сообщения вернулся в поле ввода
    const text = await page.getByRole("textbox", { name: "Сообщение сессии" }).inputValue();
    if (!text) throw new Error("текст не вернулся в поле ввода");
    await shot("rewound");
  });
  await step("сжать ведомого; вести — в ленте ведущего", async () => {
    await open("/work/wing@laptop");
    await page.getByRole("button", { name: "Откатить сюда" }).last().click();
    await page.waitForFunction(() => /do=rewind/.test(location.hash));
    await page.getByRole("button", { name: "Откатить", exact: true }).click();
    await page.waitForFunction(() => !/do=rewind/.test(location.hash));
    await page.locator(".composer-opts").getByRole("button", { name: "сжать" }).click();
    await page.waitForTimeout(3200);
    await open("/work/lead@laptop");
    await page.getByText(/Ведомый wing@laptop откачен/).first().waitFor({ timeout: 8000 });
    await page.getByText(/Ведомый wing@laptop сжат/).first().waitFor({ timeout: 8000 });
    await shot("lead-news");
  });
  await step("очистить — страница подтверждения", async () => {
    await open("/work/wing@laptop");
    await page.locator(".composer-opts").getByRole("button", { name: "очистить" }).click();
    await page.waitForFunction(() => /do=confirm/.test(location.hash));
    await shot("clear");
    await page.getByRole("button", { name: "Очистить", exact: true }).click();
    await page.getByText("разговор начат заново").first().waitFor({ timeout: 8000 });
  });
  await step("карточка разрешения: правило, путь, пояснение", async () => {
    await open("/inbox");
    await page.getByText(/запишет правило/).first().waitFor({ timeout: 8000 });
    await shot("permission");
  });
  await page.close();
}
await browser.close();
console.log(bad ? `сбоев: ${bad}` : "снимки сняты");
process.exit(bad ? 1 : 0);
