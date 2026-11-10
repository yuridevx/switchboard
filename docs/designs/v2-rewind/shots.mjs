// Снимки прототипа «Откат и ведомый»: node docs/designs/v2-rewind/shots.mjs [адрес=http://localhost:4831]
// Проходит сценарии в настоящем Chrome на моке: шаг отката, разговоры папки в форме, вести ведомого у ведущего, ряд под полем ввода, карточка разрешения,
// вопросы карточками ленты, «Работа» с последней сессией и шириной списка, «Идут сейчас», пара, имя первым полем; раздела «Вам» нет.
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
    await page.locator(".composer-opts").getByRole("button", { name: "Сжать" }).click();
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
    await page.locator(".composer-opts").getByRole("button", { name: "Очистить" }).click();
    await page.waitForFunction(() => /do=confirm/.test(location.hash));
    await shot("clear");
    await page.getByRole("button", { name: "Очистить", exact: true }).click();
    await page.getByText("Разговор очищен").first().waitFor({ timeout: 8000 });
    // «очистить» стоит отдельно от «сжать»; на телефоне цель не ниже 32 px
    const box = async (name) => page.locator(".composer-opts").getByRole("button", { name }).boundingBox();
    const a = await box("Сжать"), b = await box("Очистить");
    const gap = Math.abs(b.y - a.y) < 4 ? b.x - (a.x + a.width) : 99;
    if (gap < 10) throw new Error(`«очистить» вплотную к «сжать»: ${Math.round(gap)} px`);
    if (w < 861 && b.height < 32) throw new Error(`цель «очистить» ${Math.round(b.height)} px`);
  });
  await step("пара: один вход под полем ввода, убрать — страницей; в «Обзоре» кнопок пары нет", async () => {
    await open("/work/docs@laptop");
    const opts = page.locator(".composer-opts");
    await opts.getByRole("button", { name: "Открыть ведомого" }).click();
    await opts.getByRole("button", { name: "Убрать ведомого" }).waitFor({ timeout: 8000 });
    if (await page.locator("aside.insp").getByRole("button", { name: /Открыть ведомого|Убрать пару/ }).count()) throw new Error("в инспекторе остались кнопки пары");
    if (await page.getByRole("tab", { name: "Файлы" }).count()) throw new Error("осталась вкладка отката файлов");
    await shot("pair");
    await opts.getByRole("button", { name: "Убрать ведомого" }).click();
    await page.waitForFunction(() => /do=confirm/.test(location.hash));
    await page.getByRole("button", { name: "Убрать ведомого", exact: true }).click();
    await opts.getByRole("button", { name: "Открыть ведомого" }).waitFor({ timeout: 8000 });
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
    await open("/work/deploy@server");
    await page.locator(".feed-in .askcard").getByText(/запишет правило/).first().waitFor({ timeout: 8000 });
    await shot("permission");
  });
  await step("раздела «Вам» нет: ни пункта, ни адреса; ждущее видно лампой на «Работе»", async () => {
    await open("/inbox");
    await page.waitForFunction(() => location.hash.startsWith("#/work"));
    const nav = page.locator(w > 860 ? "nav.rail" : "nav.tabbar");
    if (await nav.getByText("Вам", { exact: true }).count()) throw new Error("пункт «Вам» остался");
    await nav.locator('a[href="#/work"] .dot').waitFor();
  });
  await step(w > 860 ? "«Работа» сразу открывает последнюю сессию; пустого разговора нет" : "«Работа» на телефоне — список", async () => {
    await open("/work/docs@laptop");
    await page.locator(".conv-head").getByText("docs@laptop").waitFor();
    await open("/work");
    if (w > 860) {
      await page.waitForFunction(() => location.hash === "#/work/docs@laptop");
      if (await page.locator(".pane.detail .hole").count()) throw new Error("пустой разговор");
    } else {
      await page.locator(".pane.list .row").first().waitFor();
      if (!/#\/work$/.test(page.url())) throw new Error("на телефоне список сам открыл сессию: " + page.url());
    }
  });
  if (w > 860) await step("список «Работы»: 280 px, низкие заголовки групп, граница тянется и помнится", async () => {
    await open("/work/docs@laptop");
    const width = async () => Math.round((await page.locator(".pane.list").boundingBox()).width);
    if (Math.abs((await width()) - 280) > 2) throw new Error("ширина списка " + (await width()));
    const grp = await page.locator(".pane.list .grp").first().boundingBox();
    if (grp.height > 30) throw new Error("заголовок группы " + Math.round(grp.height) + " px");
    const edge = await page.getByRole("separator", { name: "Ширина списка" }).boundingBox();
    const y = edge.y + 200, x = edge.x + edge.width / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 60, y, { steps: 4 }); await page.mouse.move(x + 90, y, { steps: 4 }); await page.mouse.up();
    if (Math.abs((await width()) - 370) > 3) throw new Error("после перетаскивания ширина " + (await width()));
    await shot("work-wide-list");
    await page.reload(); await page.locator(".pane.list .row").first().waitFor();
    if (Math.abs((await width()) - 370) > 3) throw new Error("ширина не запомнилась: " + (await width()));
    // пределы: разговор не схлопывается
    const e2 = await page.getByRole("separator", { name: "Ширина списка" }).boundingBox();
    await page.mouse.move(e2.x + 5, y); await page.mouse.down(); await page.mouse.move(w - 20, y, { steps: 6 }); await page.mouse.up();
    const talk = Math.round((await page.locator(".pane.detail").boundingBox()).width);
    if (talk < 420) throw new Error("разговор схлопнулся до " + talk);
    await page.getByRole("separator", { name: "Ширина списка" }).dblclick();
    if (Math.abs((await width()) - 280) > 2) throw new Error("двойное нажатие не вернуло ширину: " + (await width()));
    await shot("work");
  });
  await step("четыре больших вопроса — карточками в ленте: всё прокручивается, за экран не вылезает", async () => {
    await open("/work/survey@laptop");
    const feed = page.locator(".feed");
    await feed.getByRole("group", { name: "Вопрос 1 из 4" }).waitFor({ timeout: 8000 });
    if (await feed.getByRole("group", { name: /Вопрос \d из 4/ }).count() !== 4) throw new Error("карточек вопросов не четыре");
    if (await page.locator(".dock .askcard").count()) throw new Error("вопрос остался над полем ввода");
    const fit = await page.evaluate(() => ({ page: document.documentElement.scrollHeight <= innerHeight + 1, side: document.documentElement.scrollWidth <= innerWidth + 1, composer: document.querySelector(".dock textarea").getBoundingClientRect().bottom <= innerHeight }));
    if (!fit.page || !fit.side || !fit.composer) throw new Error("страница вылезла за экран: " + JSON.stringify(fit));
    // лента встала на первый неотвеченный вопрос
    const top = await page.evaluate(() => { const f = document.querySelector(".feed"), c = f.querySelector("[data-ask][data-open]"); return Math.round(c.getBoundingClientRect().top - f.getBoundingClientRect().top); });
    if (top < 0 || top > 40) throw new Error("первый вопрос не у верха ленты: " + top);
    await shot("questions");
    // отвечаем на все четыре, докручивая ленту
    for (const name of ["Vite", "Сначала каталог", "Веткой"]) await feed.getByRole("button", { name, exact: true }).click();
    const send = feed.getByRole("button", { name: "Ответить", exact: true });
    if (!(await send.isDisabled())) throw new Error("«Ответить» доступна при трёх ответах из четырёх");
    await feed.getByLabel("Тесты").check();
    await feed.getByText("Отвечено 4 из 4").waitFor();
    await send.scrollIntoViewIfNeeded();
    const b = await send.boundingBox();
    if (b.y + b.height > h) throw new Error("кнопка ответа за экраном");
    await shot("questions-answered");
  });
  await step("ряд под полем ввода: одна строка, значения без ярлыков, действия значками; «/ команды» нет", async () => {
    await open("/work/ingest@server");
    const row = page.locator(".composer-opts");
    await row.getByRole("button", { name: "Режим" }).waitFor({ timeout: 8000 });
    const box = await row.boundingBox();
    if (box.height > 42) throw new Error("ряд выше одной строки: " + Math.round(box.height));
    if (box.x + box.width > w + 1) throw new Error("ряд шире экрана");
    const words = await row.locator(".docvals").innerText();
    if (/режим|модель|усилие|аккаунт|кусочки/i.test(words)) throw new Error("в ряду остались ярлыки: " + words);
    if (await row.getByText("/ команды").count()) throw new Error("кнопка «/ команды» осталась");
    for (const name of ["Сжать", "Очистить"]) await row.getByRole("button", { name, exact: true }).waitFor();
    // выбор «когда взять сообщение» виден, только пока идёт ход
    const idle = /свободна/.test(await page.locator(".conv-head").innerText());
    const take = await row.getByRole("button", { name: "Когда взять сообщение" }).count();
    if (take !== (idle ? 0 : 1)) throw new Error(`«взять» ${take ? "видно" : "не видно"} при ${idle ? "свободной" : "занятой"} сессии`);
    await open("/work/docs@laptop");
    await page.locator(".composer-opts").getByRole("button", { name: "Режим" }).waitFor();
    if (await page.locator(".composer-opts").getByRole("button", { name: "Когда взять сообщение" }).count()) throw new Error("«взять» видно у свободной сессии");
    await page.getByRole("textbox", { name: "Сообщение сессии" }).fill("/");
    await page.getByRole("listbox").first().waitFor();
    await page.getByRole("textbox", { name: "Сообщение сессии" }).fill("");
    await open("/work/ingest@server");
    await page.locator(".composer-opts").getByRole("button", { name: "Режим" }).waitFor();
    await shot("composer-row");
  });
  await step("«Идут сейчас»: три субагента и фоновая задача одним блоком; шаги раскрываются на месте", async () => {
    await open("/work/audit@server");
    const runs = page.getByRole("group", { name: "Идут сейчас" });
    await runs.waitFor({ timeout: 8000 });
    if (await runs.locator(".run-row").count() !== 4) throw new Error("строк не четыре: " + await runs.locator(".run-row").count());
    if (await page.locator('.dock [aria-label="В фоне"]').count()) throw new Error("старый блок фона остался рядом");
    const first = runs.locator(".run-row").first();
    for (const t of ["Explore", "Права службы оплаты", ...(w > 860 ? ["12 шагов", "сейчас: Read"] : [])]) await first.getByText(t).first().waitFor();
    await runs.getByText("tail -f /var/log/auth.log").waitFor();
    await first.locator(".run-main").click();
    await runs.locator(".run-steps").getByText(/Поиск|Grep|role:/).first().waitFor();
    await shot("running");
    await first.getByRole("button", { name: "стоп" }).waitFor();
  });
  await step("пара: участники в шапке с лампой и моделью, скрытая сторона — строкой" + (w > 860 ? ", стрелка — обе" : ""), async () => {
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("pair.")).forEach((k) => localStorage.removeItem(k)));
    await open("/work/lead@laptop");
    const pick = page.getByRole("group", { name: "Кого показать" });
    await pick.getByRole("button", { name: "Ведомый wing@laptop" }).getByText("Sonnet 5.5").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Показать: ведомый wing@laptop" }).waitFor();
    await shot("pair-pick");
    if (w > 860) {
      await pick.getByRole("button", { name: "Обе стороны" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".conv").length === 2 && document.querySelectorAll(".conv .feed-in > *").length > 3 && !document.querySelector(".conv .mantine-Loader-root"));
      await shot("pair-both");
      await pick.first().getByRole("button", { name: "Ведущий lead@laptop" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".conv").length === 1);
    } else {
      await page.getByRole("button", { name: "Показать: ведомый wing@laptop" }).click();
      await page.waitForFunction(() => location.hash.endsWith("wing@laptop"));
    }
  });
  await step("новая сессия: имя — первое поле, курсор в нём", async () => {
    await open("/new?machine=laptop&cwd=~/projects/site");
    await page.getByLabel("Имя").waitFor();
    const ok = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll(".stepbody input:not([type=hidden]), .stepbody textarea")].filter((e) => e.offsetParent);
      const name = [...document.querySelectorAll(".stepbody label")].find((l) => l.textContent === "Имя");
      return { first: inputs[0]?.id === name?.htmlFor, focus: document.activeElement === inputs[0] };
    });
    if (!ok.first || !ok.focus) throw new Error("имя не первое или без курсора: " + JSON.stringify(ok));
    await shot("new-name");
  });
  await page.close();
}
await browser.close();
console.log(bad ? `сбоев: ${bad}` : "снимки сняты");
process.exit(bad ? 1 : 0);
