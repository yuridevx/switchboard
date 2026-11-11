// Снимки прототипа «Очереди по модели»: node docs/designs/v2-focus/shots.mjs [адрес=http://localhost:4833]
// Настоящая страница «Флот → Аккаунты» на моке в Chrome: компактный аккаунт с двумя лимитами, модель очереди, ожидание сброса.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../v2");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
const base = process.argv[2] ?? "http://localhost:4833";
const out = path.join(here, "shots");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
let bad = 0, total = 0;
for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: w < 500 });
  page.setDefaultTimeout(9000);
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const shot = (name, o = {}) => page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`), ...o });
  const step = async (label, fn) => {
    total++;
    try { await fn(); console.log(`✓ ${w} ${theme} · ${label}`); }
    catch (e) { bad++; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  const card = (machine) => page.locator(".card.mrow").filter({ has: page.getByText(machine, { exact: true }) }).first();
  const queue = (machine, name) => card(machine).locator(`[data-queue="${name}"]`);
  const current = (machine, name) => queue(machine, name).locator('.line:has([aria-label="стоит сейчас"])').getAttribute("data-drag-id");

  await step("показаны только неделя и Fable; у очереди opus строка Fable приглушена", async () => {
    await page.goto(`${base}/?mock&still#/fleet/accounts`);
    await queue("laptop", "main").waitFor();
    if (await page.getByText(/5 ч|iguana/).count()) throw new Error("видно лишнее окно");
    const rows = await queue("laptop", "main").locator(".meter-row").count();
    if (rows !== 6) throw new Error("у трёх аккаунтов не по две полоски: " + rows);
    if (!(await queue("laptop", "review").locator(".meter-row.off").count())) throw new Error("у opus лимит Fable не приглушён");
    if (await queue("laptop", "main").locator(".meter-row.off").count()) throw new Error("у fable лимит Fable приглушён");
    await shot("page", { fullPage: true });
  });
  await step("один аккаунт с Fable 99 %: очередь fable его пропускает, очередь opus на нём стоит", async () => {
    if (!(await current("laptop", "main")).endsWith("yuri@example.com")) throw new Error("main стоит на " + (await current("laptop", "main")));
    if (!(await current("laptop", "review")).endsWith("work@example.com")) throw new Error("review стоит на " + (await current("laptop", "review")));
    await card("laptop").screenshot({ path: path.join(out, `machine-${w}-${theme}.png`) });
  });
  await step("очередь fable, где у всех Fable у порога, ждёт недельного сброса", async () => {
    await queue("anya-pc", "main").getByText(/ждёт до/).waitFor();
  });
  await step("смена модели очереди: review → fable уходит с аккаунта, у которого Fable исчерпан", async () => {
    await queue("laptop", "review").locator(".qmodel").getByText("fable").click();
    await page.waitForFunction(() => document.querySelector('[data-queue="review"] .line:has([aria-label="стоит сейчас"])')?.getAttribute("data-drag-id")?.endsWith("yuri@example.com"));
    await queue("laptop", "review").locator(".meter-row.off").first().waitFor({ state: "detached" });
    await shot("review-fable");
    // обратно: аккаунт годен и для opus — очередь остаётся на нём, лимит Fable снова приглушён
    await queue("laptop", "review").locator(".qmodel").getByText("opus").click();
    await queue("laptop", "review").locator(".meter-row.off").first().waitFor();
  });
  await step("новая очередь: модель выбирается в форме", async () => {
    await card("server").getByRole("button", { name: "+ очередь" }).click();
    await page.getByLabel("Имя очереди").fill("docs");
    await page.getByRole("radiogroup", { name: "Модель очереди" }).getByText("opus").click();
    await page.getByRole("checkbox", { name: /ops@example\.com/ }).check();
    await shot("new-queue");
    await page.getByRole("button", { name: "Завести очередь" }).click();
    await queue("server", "docs").locator(".meter-row.off").first().waitFor();
  });
  await step("очередь сессии — той же строкой: имя, модель, аккаунт, два лимита, остаток", async () => {
    await page.goto(base + "/?mock&still#/work/site@laptop");
    const chip = page.getByRole("button", { name: "Очередь", exact: true });
    await chip.locator(".meter-row").first().waitFor();
    await chip.click();
    await page.getByRole("menuitem").locator(".slotline").nth(1).waitFor();
    await page.waitForTimeout(400);
    await shot("chip");
  });
  await step("колонки «Входы» нет; аккаунт добавляется в очередь кнопкой у очереди", async () => {
    await page.goto(base + "/?mock&still#/fleet/accounts");
    await queue("server", "night").waitFor();
    if (await page.locator(".queue.logins").count()) throw new Error("колонка входов на месте");
    await queue("server", "night").getByRole("button", { name: /Добавить аккаунт/ }).click();
    await page.getByRole("menuitem", { name: "yuri@example.com" }).click();
    await queue("server", "night").locator("[data-drag-id$=\"|yuri@example.com\"]").waitFor();
  });
  await page.close();
}
await browser.close();
console.log(`${total - bad} из ${total}`);
process.exit(bad ? 1 : 0);
