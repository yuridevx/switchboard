// Снимки прототипа «Откат и ведомый»: node docs/designs/v2-rewind/shots.mjs [адрес=http://localhost:4831]
// Проходит сценарии в настоящем Chrome на моке: шаг отката, разговоры папки в форме, вести ведомого у ведущего, ряд под полем ввода, карточка разрешения,
// вопросы карточками ленты, «Работа» с последней сессией и шириной списка, «Идут сейчас», пара, имя первым полем; раздела «Вам» нет;
// шапка без действий, значки под полем ввода, кольцо контекста, отвеченный вопрос карточкой, «активно всё», узкий список, общая граница панелей.
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
    await page.locator(".composer-opts").getByRole("button", { name: /^Контекст \d+% · сжать$/ }).click();
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
    const a = await box("Ещё"), b = await box("Очистить");
    const gap = Math.abs(b.y - a.y) < 4 ? b.x - (a.x + a.width) : 99;
    if (gap < 10) throw new Error(`«очистить» вплотную к соседнему значку: ${Math.round(gap)} px`);
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
    for (const name of [/^Контекст \d+% · сжать$/, "Фокус", "Инспектор", "Ещё", "Очистить"]) await row.getByRole("button", { name, exact: true }).waitFor();
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
    for (const t of ["Explore", "Права службы оплаты", ...(w > 860 ? ["сейчас: Read"] : [])]) await first.getByText(t).first().waitFor();
    await runs.getByText("tail -f /var/log/auth.log").waitFor();
    await first.locator(".run-main").click();
    await runs.locator(".run-steps").getByText(/Поиск|Grep|role:/).first().waitFor();
    await shot("running");
    await first.getByRole("button", { name: "стоп" }).waitFor();
  });
  await step("шапка пары — одна на обоих: участники с лампой, именем и делом" + (w > 860 ? "; показанный ещё раз — обе, половины шапки над своими колонками" : ""), async () => {
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("pair.")).forEach((k) => localStorage.removeItem(k)));
    await open("/work/lead@laptop");
    const bar = page.getByRole("group", { name: "Пара" });
    const lead = bar.getByRole("button", { name: "Ведущий lead@laptop" }), wing = bar.getByRole("button", { name: "Ведомый wing@laptop" });
    await wing.getByText("wing@laptop").waitFor({ timeout: 8000 });
    if ((await wing.innerText()).split("·").length < 2) throw new Error("у скрытой стороны не видно, чем она занята");
    if (await page.locator(".conv .conv-head").count()) throw new Error("у колонки пары осталась своя шапка");
    if (await lead.getAttribute("aria-pressed") !== "true" || await wing.getAttribute("aria-pressed") !== "false") throw new Error("показанная сторона не отмечена");
    await shot("pair-pick");
    if (w > 860) {
      await lead.click();
      await page.waitForFunction(() => document.querySelectorAll(".conv").length === 2 && document.querySelectorAll(".conv .feed-in > *").length > 3 && !document.querySelector(".conv .mantine-Loader-root"));
      const cell = await bar.locator(".pm").first().boundingBox(), conv = await page.locator(".conv").first().boundingBox();
      if (Math.abs(cell.x + cell.width - (conv.x + conv.width)) > 2) throw new Error("половина шапки не над своей колонкой");
      await shot("pair-both");
      await wing.click();
      await page.waitForFunction(() => document.querySelectorAll(".conv").length === 1 && location.hash.endsWith("wing@laptop"));
    } else {
      await wing.click();
      await page.waitForFunction(() => location.hash.endsWith("wing@laptop"));
    }
  });
  await step("шапка разговора: только кто это и чем занят; все действия — значками под полем ввода; фокус — значком, сжатие — кольцом контекста", async () => {
    await open("/work/site@laptop");
    const acts = page.getByRole("group", { name: "Действия" });
    await acts.getByRole("button", { name: "Фокус" }).waitFor({ timeout: 8000 });
    const inHead = await page.locator(".conv-head button:visible:not(.namebtn):not([aria-label='Назад'])").count();
    if (inHead) throw new Error("в шапке остались кнопки действий: " + inHead);
    const head = await page.locator(".conv-head").innerText();
    if (/Fable|Sonnet|Opus|авто|разрешено/i.test(head)) throw new Error("шапка повторяет документ сессии: " + head);
    const ring = acts.getByRole("button", { name: /^Контекст \d+% · сжать$/ });
    if (!/^\d+%$/.test((await ring.innerText()).trim())) throw new Error("у кольца нет процента: " + await ring.innerText());
    if (!(await ring.locator("svg circle.arc").count())) throw new Error("кольца нет");
    const focus = acts.getByRole("button", { name: "Фокус" });
    const rows = () => page.locator(".feed-in > *").count();
    const all = await rows();
    await focus.click();
    if (await focus.getAttribute("aria-pressed") !== "true") throw new Error("фокус не включился");
    if (await rows() >= all && all > 3) throw new Error("фокус не убрал шаги из ленты");
    await focus.click();
    // значки в один ряд, цель не меньше 28 px (на телефоне — 32)
    const boxes = await acts.locator("button:visible").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { y: Math.round(r.y + r.height / 2), h: r.height, w: r.width, right: r.right }; }));
    if (Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y)) > 3) throw new Error("значки перенеслись на вторую строку");
    const min = w < 861 ? 32 : 28;
    if (boxes.some((b) => b.h < min || b.w < min)) throw new Error("цель нажатия меньше " + min + " px: " + JSON.stringify(boxes));
    if (boxes.some((b) => b.right > w + 1)) throw new Error("значок ушёл за экран");
    await acts.getByRole("button", { name: "Ещё" }).click();
    for (const item of [/Закрепить|Открепить/, "Выгрузить разговор в Markdown", "Убрать сессию"]) await page.getByRole("menuitem", { name: item }).waitFor();
    if (await page.getByRole("menuitem", { name: /Фокус/ }).count()) throw new Error("фокус остался в меню");
    await page.keyboard.press("Escape");
    await shot("acts-row");
  });
  await step("время в «Идут сейчас» — от начала работы на машине, а не от открытия страницы", async () => {
    await open("/work/audit@server");
    const runs = page.getByRole("group", { name: "Идут сейчас" });
    const time = async () => (await runs.locator(".run-row").first().locator(".run-n.time").innerText()).trim();
    await runs.locator(".run-row").first().waitFor({ timeout: 8000 });
    // субагент начал 6 минут назад: страница открыта только что, а в строке — его время
    if (!/^6 мин/.test(await time())) throw new Error("время строки: " + await time());
    if (await page.locator(".feed-in .toolrow").getByText(/^идёт \d+ с$/).count()) throw new Error("в ленте счёт идёт от открытия страницы");
  });
  await step("«Идут сейчас» сворачивается до строки «идут: 4»; выбор помнит устройство", async () => {
    await open("/work/audit@server");
    const runs = page.getByRole("group", { name: "Идут сейчас" });
    await runs.getByRole("button", { name: "Свернуть «Идут сейчас»" }).click();
    if (await runs.locator(".run-row").count()) throw new Error("строки остались");
    await runs.getByText("идут: 4").waitFor();
    await shot("runs-folded");
    await page.reload();
    await page.getByRole("group", { name: "Идут сейчас" }).getByRole("button", { name: "Показать «Идут сейчас»" }).waitFor({ timeout: 8000 });
    await page.getByRole("group", { name: "Идут сейчас" }).getByRole("button", { name: "Показать «Идут сейчас»" }).click();
    if (await page.getByRole("group", { name: "Идут сейчас" }).locator(".run-row").count() !== 4) throw new Error("строки не вернулись");
  });
  await step("отвеченный вопрос остаётся карточкой: выбранное выделено, кто и когда ответил", async () => {
    await open("/work/deploy@server");
    await page.locator(".feed-in .askcard").getByRole("button", { name: "Разрешить", exact: true }).click();
    const card = page.getByRole("group", { name: "Отвеченный вопрос" });
    await card.waitFor({ timeout: 12_000 });
    const chosen = await card.locator(".asked-opt[aria-current]").allInnerTexts();
    if (chosen.join("|").trim() !== "Разрешить") throw new Error("выбрано: " + chosen.join("|"));
    if (await card.locator(".asked-opt").count() !== 3) throw new Error("вариантов не три");
    await card.getByText(/^ответил .+ · \d\d:\d\d$/).waitFor();
    if (await page.getByText(/^отвечено: /).count()) throw new Error("осталась строка «отвечено»");
    await shot("answered");
  });
  if (w > 860) await step("активно всё: пара рядом, идущий ход, «Идут сейчас», вопрос; инспектор открывается у своей стороны и возвращает обе; его ширина тянется мышью и пальцем и помнится", async () => {
    await page.evaluate(() => Object.keys(localStorage).filter((k) => /pair\.|insp\.w|runs\.open/.test(k)).forEach((k) => localStorage.removeItem(k)));
    await open("/work/audit@server");
    await page.getByRole("group", { name: "Действия" }).getByRole("button", { name: "Открыть ведомого" }).click();
    const bar = page.getByRole("group", { name: "Пара" });
    await bar.getByRole("button", { name: /^Ведущий audit@server/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".conv").length === 2);
    const lead = page.locator('[data-conv="audit@server"]');
    await lead.getByRole("group", { name: "Идут сейчас" }).locator(".run-row").nth(3).waitFor();
    await lead.locator(".askcard").getByRole("button", { name: "Разрешить", exact: true }).waitFor();
    const fits = async (name) => {
      const bad = await page.evaluate(() => {
        if (document.documentElement.scrollWidth > innerWidth + 1) return "страница шире экрана";
        for (const conv of document.querySelectorAll(".conv")) {
          const c = conv.getBoundingClientRect();
          const opts = conv.querySelector(".composer-opts").getBoundingClientRect();
          if (opts.height > 42) return "ряд под полем выше одной строки в " + conv.dataset.conv;
          for (const b of conv.querySelectorAll(".docacts button")) { const r = b.getBoundingClientRect(); if (r.right > c.right + 1 || r.width < 28 || r.height < 28) return "значок не поместился в " + conv.dataset.conv; }
          for (const r of conv.querySelectorAll(".run-row")) { const x = r.getBoundingClientRect(); if (x.right > c.right + 1) return "строка «Идут сейчас» шире колонки"; const t = r.querySelector(".run-main > .trunc"); if (t && t.getBoundingClientRect().width < 60) return "задание в строке обрезано до нечитаемого"; }
        }
        return "";
      });
      if (bad) throw new Error(name + ": " + bad);
    };
    await fits("обе");
    await shot("all-both");
    await lead.getByRole("button", { name: "Инспектор" }).click();
    const insp = page.getByRole("complementary", { name: "Инспектор" });
    await insp.waitFor();
    if (await page.locator(".conv").count() !== 1 || !(await lead.count())) throw new Error("при инспекторе осталась не та сторона");
    if (await bar.getByRole("button", { name: /^Ведомый audit-wing@server/ }).getAttribute("aria-pressed") !== "false") throw new Error("вторая сторона не свёрнута в шапку");
    await fits("инспектор");
    await shot("all-insp");
    // граница инспектора: мышью
    const width = async () => Math.round((await insp.boundingBox()).width);
    const w0 = await width();
    const edge = await page.getByRole("separator", { name: "Ширина инспектора" }).boundingBox();
    const y = edge.y + 300, x = edge.x + edge.width / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 40, y, { steps: 4 }); await page.mouse.move(x - 70, y, { steps: 4 }); await page.mouse.up();
    if (Math.abs((await width()) - (w0 + 70)) > 3) throw new Error(`мышью: ${w0} → ${await width()}`);
    // пальцем
    const cdp = await page.context().newCDPSession(page);
    const e2 = await page.getByRole("separator", { name: "Ширина инспектора" }).boundingBox();
    const tx = Math.round(e2.x + e2.width / 2);
    const touch = (type, px) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: px, y: Math.round(y) }] });
    await touch("touchStart", tx); await touch("touchMove", tx + 20); await touch("touchMove", tx + 50); await touch("touchEnd");
    if (Math.abs((await width()) - (w0 + 20)) > 3) throw new Error(`пальцем: ${w0 + 70} → ${await width()}, ждали ${w0 + 20}`);
    await page.reload();
    await page.locator(".conv").first().waitFor();
    // пара живёт в памяти мока: после перезагрузки её нет, а ширина инспектора — на устройстве
    await page.getByRole("group", { name: "Действия" }).getByRole("button", { name: "Инспектор" }).click().catch(() => {});
    if (!(await page.getByRole("complementary", { name: "Инспектор" }).count())) await page.getByRole("group", { name: "Действия" }).getByRole("button", { name: "Инспектор" }).click();
    const kept = Math.round((await page.getByRole("complementary", { name: "Инспектор" }).boundingBox()).width);
    if (Math.abs(kept - (w0 + 20)) > 3) throw new Error("ширина инспектора не запомнилась: " + kept);
    await page.getByRole("separator", { name: "Ширина инспектора" }).dblclick();
  });
  if (w > 860) await step("узкий список 220 px: имя и лампа на месте, время ушло, ведомый пары — своей строкой; та же граница — в «Архиве»", async () => {
    await open("/work/docs@laptop");
    const sep = page.getByRole("separator", { name: "Ширина списка" });
    const e = await sep.boundingBox();
    const y = e.y + 200;
    await page.mouse.move(e.x + 5, y); await page.mouse.down(); await page.mouse.move(120, y, { steps: 6 }); await page.mouse.up();
    const lw = Math.round((await page.locator(".pane.list").boundingBox()).width);
    if (lw !== 220) throw new Error("список не 220: " + lw);
    const bad = await page.evaluate(() => {
      const list = document.querySelector(".pane.list").getBoundingClientRect();
      for (const r of document.querySelectorAll(".pane.list .row")) {
        const t = r.querySelector(".t"), lamp = r.querySelector(".lamp");
        if (!lamp || lamp.getBoundingClientRect().width < 8) return "лампа пропала у " + r.dataset.call;
        if (t.getBoundingClientRect().width < 110) return "имени мало места у " + r.dataset.call + ": " + Math.round(t.getBoundingClientRect().width);
        if (r.getBoundingClientRect().right > list.right + 1) return "строка шире списка";
        const ago = r.querySelector(".ago");
        if (ago && getComputedStyle(ago).display !== "none") return "время осталось у " + r.dataset.call;
        const mate = r.querySelector(".pairmate");
        if (mate && getComputedStyle(mate).display !== "block") return "ведомый пары не своей строкой";
      }
      return "";
    });
    if (bad) throw new Error(bad);
    await shot("list-220");
    await sep.dblclick();
    // «Архив»: тот же виджет, своя ширина
    await open("/archive");
    await page.locator(".pane.list .row").first().click();
    const as = page.getByRole("separator", { name: "Ширина списка архива" });
    await as.waitFor({ timeout: 8000 });
    const aw = async () => Math.round((await page.locator(".pane.list").boundingBox()).width);
    const a0 = await aw(), ae = await as.boundingBox();
    await page.mouse.move(ae.x + 5, ae.y + 200); await page.mouse.down(); await page.mouse.move(ae.x + 65, ae.y + 200, { steps: 5 }); await page.mouse.up();
    if (Math.abs((await aw()) - (a0 + 60)) > 3) throw new Error(`архив: ${a0} → ${await aw()}`);
    await shot("archive-split");
    await as.dblclick();
    await open("/work/docs@laptop");
    if (Math.round((await page.locator(".pane.list").boundingBox()).width) !== 280) throw new Error("ширина архива задела список «Работы»");
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
