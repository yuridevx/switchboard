// Снимки «Низа разговора»: node docs/designs/v2-chatbar/shots.mjs [папка=shots] [адрес=http://localhost:4839]
// Настоящая страница разговора на моке в Chrome: ряд значков под полем ввода, меню значения, две срочности кнопками, панель «о сессии» по кнопке.
// На 1280 жесты — мышью, на 390 — пальцем.
// Папка «before» снимается тем же сценарием с ветки main: шаги, которых там нет, падают — это и есть «до».
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const { chromium } = createRequire(path.join(root, "web", "package.json"))("playwright-core");
const out = path.join(here, process.argv[2] ?? "shots");
const base = process.argv[3] ?? "http://localhost:4839";
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
let bad = 0, total = 0;
for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
  const wide = w > 860;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: !wide });
  page.setDefaultTimeout(9000);
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const shot = (name, o = {}) => page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`), ...o });
  const dockShot = (name, conv = page) => conv.locator(".dock").first().screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`) });
  /** Нажатие: на широком экране — мышью, на телефоне — пальцем. */
  const press = (loc) => (wide ? loc.click() : loc.tap());
  const step = async (label, fn) => {
    total++;
    try { await fn(); console.log(`✓ ${w} ${theme} · ${label}`); }
    catch (e) { bad++; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  const open = async (callsign) => {
    await page.goto(`${base}/?mock&still#/work/${callsign}`);
    await page.reload();
    await page.getByLabel("Сообщение сессии").first().waitFor();
    await page.waitForTimeout(500);
  };
  /** Ряды под полем ввода: ни одно значение не обрезано, не прокручено и не наезжает на соседа. */
  const fits = async () => {
    const r = await page.evaluate(() => [...document.querySelectorAll(".composer-opts")].map((row) => {
      const els = [...row.querySelectorAll(".docval, .ctxring, .cacheclock, .docacts > *")].filter((e) => e.getClientRects().length);
      const box = row.getBoundingClientRect();
      const r = els.map((e) => e.getBoundingClientRect());
      const cut = r.filter((x) => x.left < box.left - 1 || x.right > box.right + 1).length + els.filter((e) => e.scrollWidth > e.clientWidth + 1).length;
      let over = 0;
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].right - 1 && r[j].left < r[i].right - 1 && r[i].top < r[j].bottom - 1 && r[j].top < r[i].bottom - 1) over++;
      return { n: els.length, cut, over, w: Math.round(box.width), h: Math.round(box.height) };
    }));
    console.log("    ряд:", JSON.stringify(r));
    const sum = r.reduce((a, x) => a + x.cut + x.over, 0);
    if (!r.length || sum) throw new Error(`обрезано или наложено: ${sum}`);
  };
  const values = () => page.getByRole("group", { name: "Документ сессии" }).first();

  await step("ход идёт: ряд значков без обрезок и наложений, панели справа нет", async () => {
    await open("site@laptop");
    if (await page.getByRole("complementary", { name: "Инспектор" }).count()) throw new Error("панель справа открыта сама");
    await fits();
    await shot("talk");
    await dockShot("dock");
  });
  await step("слов «разрешено всё», «усилие модели», аккаунта и его лимитов в ряду нет; час кэша — в ряду", async () => {
    const text = await values().innerText();
    if ((await values().locator(".meter, .meter-row").count()) || (await values().getByRole("button", { name: /Очередь|Аккаунт/ }).count())) throw new Error("в ряду остался аккаунт или его лимиты");
    if (!(await values().locator("[data-cache]").count())) throw new Error("часов кэша в ряду нет");
    for (const word of ["разрешено всё", "усилие", "@example.com", "взять"]) if (text.includes(word)) throw new Error("в ряду осталось: " + word);
  });
  await step("срочностей две, обе кнопками: молния — сейчас, стрелка — следующим; меню «взять» нет", async () => {
    if (await page.getByLabel("Когда взять сообщение").count()) throw new Error("меню срочности осталось");
    const box = page.getByLabel("Сообщение сессии").first();
    await box.fill("И подвал тоже проверь на 390");
    await dockShot("turn");
    await box.press("Enter");
    await page.getByText("в очереди").first().waitFor();
    await box.fill("Стоп: сначала тесты");
    await press(page.getByRole("button", { name: "Отправить сейчас" }));
    await page.getByText("Request interrupted by user").first().waitFor().catch(() => page.getByText("Стоп: сначала тесты").first().waitFor());
    await shot("now");
  });
  await step("режим не «разрешено всё» — значок цветом и слово (в узкой колонке — только цветом)", async () => {
    await open("site@laptop");
    await press(values().getByRole("button", { name: "Режим" }));
    await page.getByRole("menu").waitFor();
    await page.waitForTimeout(350);
    await shot("mode-menu");
    await press(page.getByRole("menuitem", { name: "спрашивать" }));
    await values().locator(".docval.loud").waitFor();
    if (wide && !(await values().innerText()).includes("спрашивать")) throw new Error("слова режима нет");
    await fits();
    await dockShot("mode-loud");
  });
  await step("модель: значение ряда открывает общий список с поиском и закрепами; выбор ставит модель", async () => {
    await open("site@laptop");
    await press(values().getByRole("button", { name: "Модель" }));
    await page.getByRole("listbox", { name: "Модели" }).waitFor();
    await page.locator('[data-offer="claude/claude-opus-5-5"]').waitFor();
    await page.waitForTimeout(350);
    await shot("model-menu");
    await press(page.locator('[data-offer="claude/claude-opus-5-5"] .mp-pick'));
    await page.getByRole("listbox", { name: "Модели" }).waitFor({ state: "detached" });
    await page.waitForFunction(() => /Opus 5\.5/.test(document.querySelector('[aria-label="Документ сессии"] [aria-label="Модель"]')?.textContent ?? ""));
    await fits();
  });
  await step("усилие: ступеньки в ряду и в меню", async () => {
    await press(values().getByRole("button", { name: "Усилие" }));
    await page.getByRole("menuitem", { name: "предельное" }).waitFor();
    await page.waitForTimeout(350);
    await shot("effort-menu");
    await press(page.getByRole("menuitem", { name: "предельное" }));
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Усилие"] .effort rect.on').length === 5);
  });
  await step("сессия свободна: одна кнопка отправки", async () => {
    await open("docs@laptop");
    if (await page.getByRole("button", { name: "Отправить сейчас" }).count()) throw new Error("молния у свободной сессии");
    await fits();
    await dockShot("idle");
  });
  await step("панель «о сессии» открывается кнопкой и закрывается ею же", async () => {
    await open("site@laptop");
    await press(page.getByRole("group", { name: "Действия" }).first().getByRole("button", { name: "Инспектор" }));
    if (wide) {
      await page.getByRole("complementary", { name: "Инспектор" }).waitFor();
      await fits();
      await shot("panel");
      await press(page.getByRole("group", { name: "Действия" }).first().getByRole("button", { name: "Инспектор" }));
      await page.getByRole("complementary", { name: "Инспектор" }).waitFor({ state: "detached" });
    } else {
      await page.getByRole("tab", { name: "Обзор" }).waitFor();
      await shot("panel");
    }
  });
  if (wide) await step("пара рядом: в каждой колонке ряд в кратком виде, действия второй строкой", async () => {
    await open("lead@laptop");
    await page.getByRole("button", { name: /^Ведущий/ }).click();
    await page.locator(".talk.pair").waitFor();
    await page.waitForTimeout(400);
    await fits();
    await shot("pair");
  });
  await page.close();
}
await browser.close();
console.log(`${total - bad} из ${total}`);
process.exit(bad ? 1 : 0);
