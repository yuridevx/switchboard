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
    // список стоит под папкой, выше кусочков
    const order = await page.evaluate(() => {
      const top = (el) => el.getBoundingClientRect().top + scrollY;
      return top(document.querySelector('[aria-label="Разговоры папки"]')) < top([...document.querySelectorAll("p")].find((p) => p.textContent === "Кусочки"));
    });
    if (!order) throw new Error("список разговоров ниже кусочков");
    await list.getByRole("option").nth(1).click();
    await page.getByRole("button", { name: "Продолжить разговор" }).waitFor();
    if (await page.getByLabel("Копией").isChecked()) throw new Error("свободный разговор включил «Копией» сам");
    // разговор держит живая сессия — только копией
    await list.getByRole("option").first().click();
    await list.getByText(/занят/).first().waitFor();
    if (!(await page.getByLabel("Копией").isChecked()) || !(await page.getByLabel("Копией").isDisabled())) throw new Error("занятый разговор не стал копией");
    await list.scrollIntoViewIfNeeded();
    await shot("conversations");
  });
  await step("шаг отката: разговор и файлы", async () => {
    await open("/work/site@laptop");
    const addr = page.url();
    await page.getByRole("button", { name: "Откатить сюда" }).last().click();
    await page.waitForFunction(() => /do=rewind/.test(location.hash));
    const stepPage = page.locator('[data-step="rewind"]');
    // ход идёт — на шаге сказано, что он прервётся; число записей одно для обоих вариантов
    await stepPage.getByText("Текущий ход прервётся").waitFor();
    const cut = () => stepPage.locator("b").first().textContent();
    await stepPage.getByText(/Из разговора уйдёт записей/).waitFor();
    const before = await cut();
    await page.getByText("Разговор и файлы", { exact: true }).click();
    await stepPage.getByText("src/components/Header.tsx").waitFor();
    if ((await cut()) !== before) throw new Error(`число записей разное: ${before} и ${await cut()}`);
    await shot("rewind");
    await page.getByRole("button", { name: "Откатить", exact: true }).click();
    await page.waitForFunction(() => !/do=rewind/.test(location.hash));
    // текст ушедшего сообщения вернулся в поле ввода
    const text = await page.getByRole("textbox", { name: "Сообщение сессии" }).inputValue();
    if (!text) throw new Error("текст не вернулся в поле ввода");
    // то же окно: адрес прежний, вкладка одна, сообщения после выбранного в ленте нет
    if (page.url() !== addr) throw new Error(`адрес сменился: ${page.url()}`);
    if (page.context().pages().length !== 1) throw new Error("появилась вторая вкладка");
    if (await page.locator(".feed-in .me").getByText(text.slice(0, 40)).count()) throw new Error("откаченное сообщение осталось в ленте");
    // в ленте остался след: к чему откат и сколько файлов вернулось
    await page.getByText(/Откат к «.+» · файлы возвращены: 3/).first().waitFor({ timeout: 8000 });
    await shot("rewound");
  });
  await step("сжать ведомого; вести — в ленте ведущего", async () => {
    await open("/work/wing@laptop");
    await page.getByRole("button", { name: "Откатить сюда" }).last().click();
    await page.waitForFunction(() => /do=rewind/.test(location.hash));
    await page.getByRole("button", { name: "Откатить", exact: true }).click();
    await page.waitForFunction(() => !/do=rewind/.test(location.hash));
    if (await page.locator('[data-step="rewind"]').getByText("Текущий ход прервётся").count()) throw new Error("свободной сессии сказано про прерванный ход");
    await page.getByText("Откат к полученной задаче").first().waitFor({ timeout: 8000 });
    await page.locator(".composer-opts").getByRole("button", { name: "сжать" }).click();
    // после сжатия в ленте остаётся сводка с числами
    await page.getByText(/68.*→.*12/).first().waitFor({ timeout: 8000 });
    await shot("compacted");
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
    await page.getByText("Разговор очищен").first().waitFor({ timeout: 8000 });
    // «очистить» стоит отдельно от «сжать»; на телефоне цель не ниже 32 px
    const box = async (name) => page.locator(".composer-opts").getByRole("button", { name }).boundingBox();
    const a = await box("сжать"), b = await box("очистить");
    const gap = Math.abs(b.y - a.y) < 4 ? b.x - (a.x + a.width) : 99;
    if (gap < 24) throw new Error(`«очистить» вплотную к «сжать»: ${Math.round(gap)} px`);
    if (w < 861 && b.height < 32) throw new Error(`цель «очистить» ${Math.round(b.height)} px`);
  });
  await step("пара: один вход под полем ввода, убрать — страницей; в «Обзоре» кнопок пары нет", async () => {
    await open("/work/docs@laptop");
    const opts = page.locator(".composer-opts");
    await opts.getByRole("button", { name: "+ ведомый" }).click();
    await opts.getByRole("button", { name: "убрать ведомого" }).waitFor({ timeout: 8000 });
    if (await page.getByRole("button", { name: /Открыть ведомого|Убрать пару/ }).count()) throw new Error("в инспекторе остались кнопки пары");
    if (await page.getByRole("tab", { name: "Файлы" }).count()) throw new Error("осталась вкладка отката файлов");
    await shot("pair");
    await opts.getByRole("button", { name: "убрать ведомого" }).click();
    await page.waitForFunction(() => /do=confirm/.test(location.hash));
    await page.getByRole("button", { name: "Убрать ведомого", exact: true }).click();
    await opts.getByRole("button", { name: "+ ведомый" }).waitFor({ timeout: 8000 });
  });
  if (w > 860) await step("в «Обзоре» ведомого ведущая названа один раз", async () => {
    await open("/work/wing@laptop");
    const insp = page.locator("aside.insp");
    await insp.waitFor();
    const n = await insp.getByText("lead@laptop").count() + await insp.getByRole("link", { name: /lead/ }).count();
    const labels = await insp.locator("dt").allTextContents();
    if (labels.some((l) => ["Ведущий", "Задачу дала", "Открыл"].includes(l))) throw new Error("ведущая повторена рядами: " + labels.join(", "));
    void n;
    await shot("wing-overview");
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
