// Снимки экранов дизайна «Аккаунты и модели»: node docs/designs/v2-accounts/shots.mjs [папка=shots] [адрес=http://localhost:4838]
// Настоящая страница на моке в Chrome (из web/: npx vite --port 4838 --strictPort): аккаунты Claude без очередей, провайдер с каталогом,
// выбор модели с поиском и закрепами, час кэша, сверка модели. На 1280 — мышью, на 390 — пальцем.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const { chromium } = createRequire(path.join(root, "web", "package.json"))("playwright-core");
const out = path.join(here, process.argv[2] ?? "shots");
const base = process.argv[3] ?? "http://localhost:4838";
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
let bad = 0, total = 0;
for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
  const wide = w > 860;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: !wide });
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const shot = (name, o = {}) => page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`), ...o });
  const dockShot = (name) => page.locator(".dock").first().screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`) });
  const step = async (label, fn) => {
    total++;
    try { await fn(); if (errors.length) throw new Error("ошибка страницы: " + errors.splice(0).join(" | ")); console.log(`✓ ${w} ${theme} · ${label}`); }
    catch (e) { bad++; errors.length = 0; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  const go = async (hash, wait) => { await page.goto(`${base}/?mock&still#${hash}`); await page.reload(); await wait.first().waitFor(); await page.waitForTimeout(500); };
  const openTalk = (callsign) => go(`/work/${callsign}`, page.getByLabel("Сообщение сессии"));
  /** Нажатие: на широком экране — мышью, на телефоне — пальцем. */
  const press = (loc) => (wide ? loc.click() : loc.tap());
  /** Ряд под полем ввода: значения документа и действия не наложены друг на друга, действия целиком в ряду, значки действий не наложены. */
  const fits = async () => {
    const sum = await page.evaluate(() => [...document.querySelectorAll(".composer-opts")].reduce((n, row) => {
      const box = row.getBoundingClientRect();
      const parts = [...row.querySelectorAll(":scope > .docvals, :scope > .docval, :scope > .docacts")].filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect());
      const acts = [...row.querySelectorAll(".docacts > *")].filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect());
      const over = (r) => { let x = 0; for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].right - 1 && r[j].left < r[i].right - 1 && r[i].top < r[j].bottom - 1 && r[j].top < r[i].bottom - 1) x++; return x; };
      // ряд занятой сессии на телефоне не помещается и в main (это правит дизайн «Низ разговора»): у него край не проверяется
      const edge = innerWidth <= 860 && row.querySelector(":scope > .take") ? 0 : acts.filter((q) => q.left < box.left - 1 || q.right > box.right + 1).length;
      return n + over(parts) + over(acts) + edge;
    }, 0));
    if (sum) throw new Error(`обрезано или наложено: ${sum}`);
  };
  const opts = () => page.locator(".composer-opts").first();
  const values = () => page.getByRole("group", { name: "Документ сессии" }).first();
  const claude = () => page.locator('[data-card="claude"]');

  await step("аккаунты: один список на флот, очередей и входов на машинах нет", async () => {
    await go("/fleet/accounts", claude());
    await claude().locator("[data-account]").first().waitFor();
    if (await claude().locator(".acols").getByText(/очередь|Войти|Опросить|сесси|до \d+ /i).count()) throw new Error("остались очереди, вход на машине или подписи словами");
    if ((await claude().locator("[data-account]").count()) !== 6) throw new Error("аккаунтов не шесть");
    if (!(await claude().getByLabel(/Claude не принял токен/).count())) throw new Error("негодный токен не отмечен");
    if ((await claude().locator("[data-token]").count()) !== 5) throw new Error("кольцо срока токена не у пяти аккаунтов");
    if ((await claude().locator('[data-account="yuri@example.com"] .sdots .lamp').count()) < 2) throw new Error("у аккаунта нет точек его сессий");
    if ((await claude().locator(".vbar .pace").count()) !== 12) throw new Error("черта прошедшей недели не на двенадцати столбиках");
    const order = await claude().locator("[data-account]").evaluateAll((els) => els.map((e) => e.getAttribute("data-account").split("@")[0]));
    if (order.join() !== "anya,ops,yuri,night,work,team") throw new Error("столбцы стоят не по времени сброса: " + order.join());
    if (await page.getByRole("button", { name: /очередь|ссылку входа/i }).count()) throw new Error("на экране остались очереди или вход по ссылке");
    if ((await page.locator('[data-card="moves"] .line').count()) < 4) throw new Error("ленты переходов нет");
    await shot("accounts", { fullPage: true });
  });
  await step("флаг «беречь Fable»: снят — запаса на полоске недели нет; поставлен — есть", async () => {
    const row = claude().locator('[data-account="yuri@example.com"]');
    const flag = row.getByRole("button", { name: "Беречь запас Fable" });
    if ((await flag.getAttribute("aria-pressed")) !== "true" || !(await row.locator(".vbar i.hold").count())) throw new Error("запас не показан при поставленном флаге");
    await press(flag);
    await row.locator(".vbar i.hold").waitFor({ state: "detached" });
    if ((await row.getByRole("button", { name: "Беречь запас Fable" }).getAttribute("aria-pressed")) !== "false") throw new Error("флаг не снят");
    await shot("reserve-off");
    await press(row.getByRole("button", { name: "Беречь запас Fable" }));
    await row.locator(".vbar i.hold").waitFor();
  });
  await step("новый аккаунт: почта и годовой токен — аккаунт появился в списке", async () => {
    await press(claude().getByRole("button", { name: "Добавить аккаунт" }));
    await page.getByLabel("Почта аккаунта").fill("new@example.com");
    await page.getByLabel("Токен", { exact: true }).fill("sk-ant-oat01-" + "x".repeat(40));
    await shot("account-new");
    await press(page.getByRole("button", { name: "Добавить аккаунт" }).last());
    await claude().locator('[data-account="new@example.com"]').waitFor();
  });
  await step("провайдер: один ключ на все его модели; модели по умолчанию, соответствия имён и окна у ключа нет", async () => {
    await press(page.getByLabel("Действия: провайдер orca"));
    await press(page.getByRole("menuitem", { name: "Изменить" }));
    await page.getByLabel("Адрес API").waitFor();
    if (await page.getByLabel(/Модель по умолчанию|Модели|Окно/).count()) throw new Error("у ключа остались модель по умолчанию, соответствие имён или окно");
    for (const label of ["Имя", "Протокол", "Адрес API", "Настройки сессии", "Окружение сессии", "Новый ключ"]) if (!(await page.getByLabel(label, { exact: true }).count())) throw new Error("нет поля " + label);
    await shot("provider");
  });
  // на телефоне посреди хода часов кэша в ряду нет — там снимается свободная сессия
  const calm = wide ? "site@laptop" : "design@anya-pc";
  await step("ряд сессии: аккаунта и его лимитов нет, час кэша есть; ничего не обрезано", async () => {
    await openTalk(calm);
    await opts().locator('[data-cache="warm"]').waitFor();
    if ((await opts().locator(".meter-row, [data-limit]").count()) || (await opts().getByRole("button", { name: /Аккаунт|Очередь/ }).count())) throw new Error("в ряду сессии остался аккаунт или его лимиты");
    if (/yuri|anya|@/.test(await opts().innerText())) throw new Error("в ряду сессии назван аккаунт");
    await shot("talk");
    await dockShot("dock");
    await fits();
  });
  await step("выбор модели: закреплённые сверху, поиск по каталогу провайдера, выбор ставит провайдера и модель", async () => {
    await press(values().getByRole("button", { name: "Модель" }));
    await page.getByRole("listbox", { name: "Модели" }).waitFor();
    await page.waitForTimeout(300);
    if (!(await page.locator(".mp-row").first().locator('.mp-pin[aria-pressed="true"]').count())) throw new Error("закреплённые не сверху");
    if ((await page.locator('[data-offer^="claude/"]').count()) !== 15) throw new Error("моделей Claude в списке не 15");
    const groups = await page.locator(".mp-group").allInnerTexts();
    if ((await page.locator('[data-offer^="orca/"]').count()) !== 24) throw new Error("моделей провайдера orca в списке не 24");
    for (const g of ["Claude · Fable", "Claude · Opus", "Claude · Sonnet", "Claude · Haiku", "orca", "meta-muse"]) if (!groups.includes(g)) throw new Error("нет группы " + g);
    await shot("models");
    await page.getByLabel("Найти модель").fill("qwen");
    await page.waitForTimeout(150);
    if ((await page.locator(".mp-row").count()) !== 3) throw new Error("поиск qwen нашёл не три модели");
    await shot("models-search");
    await press(page.locator('[data-offer="orca/qwen-3.5-coder"] .mp-pick'));
    await values().getByText("qwen-3.5-coder").waitFor();
    if (!(await values().getByRole("button", { name: "Модель" }).innerText()).includes("orca")) throw new Error("у сессии на провайдере он не назван");
    if (await opts().getByRole("button", { name: /Аккаунт|Очередь/ }).count()) throw new Error("у сессии на ключе остался выбор аккаунта");
    await fits();
    await dockShot("on-key");
  });
  await step("закреп: модель закреплена — стоит сверху и после перезагрузки списка", async () => {
    await press(values().getByRole("button", { name: "Модель" }));
    await page.getByLabel("Найти модель").fill("kimi-k3-th");
    await press(page.getByRole("button", { name: "Закрепить kimi-k3-thinking" }));
    await page.getByLabel("Найти модель").fill("");
    const first = page.getByRole("listbox", { name: "Модели" }).locator(".mp-row");
    const texts = await first.allInnerTexts();
    if (!texts.slice(0, 4).some((t) => t.includes("kimi-k3-thinking"))) throw new Error("закреплённой модели нет сверху");
    await page.keyboard.press("Escape");
  });
  await step("/model в поле ввода: открывает тот же список с поиском, Enter ставит модель; в разговор команда не уходит", async () => {
    await openTalk("docs@laptop");
    const box = page.getByLabel("Сообщение сессии").first();
    await box.fill("/model opus 4");
    await box.press("Enter");
    await page.getByRole("listbox", { name: "Модели" }).waitFor();
    await page.waitForTimeout(300);
    if ((await page.locator(".mp-row").count()) !== 4) throw new Error("по «opus 4» найдено не четыре модели");
    await shot("model-command");
    await page.getByLabel("Найти модель").press("Enter");
    await values().getByText("Opus 4.8").waitFor();
    if (await page.locator(".feed").getByText("/model").count()) throw new Error("команда ушла в разговор");
    await dockShot("model-set");
  });
  await step("отвечает не та модель, что выбрана, — в ряду видны обе", async () => {
    await openTalk("docs@laptop");
    await values().locator(".docval.loud").first().waitFor();
    if (!(await values().innerText()).includes("≠ Opus 5.5")) throw new Error("отвечающая модель не названа");
    await dockShot("drift");
    await fits();
  });
  await step("разговор от 200 К: на часах кэша засечка автосжатия", async () => {
    await openTalk(wide ? "lead@laptop" : "design@anya-pc");
    await page.locator(".cacheclock .notch").first().waitFor();
    await dockShot("cache-big");
    await fits();
  });
  await step("остановленная сессия: модель меняется тем же списком", async () => {
    await openTalk("hotfix@laptop");
    await press(values().getByRole("button", { name: "Модель" }));
    await page.getByRole("listbox", { name: "Модели" }).waitFor();
    if ((await page.locator('[data-offer^="claude/"]').count()) !== 15) throw new Error("у остановленной сессии список моделей другой");
    await shot("stopped-models");
    await page.keyboard.press("Escape");
  });
  await step("новая сессия: модель из того же списка; поля аккаунта нет", async () => {
    await go("/new", page.getByText("Модель", { exact: true }));
    await press(page.getByText("laptop", { exact: true }).first());
    await page.waitForTimeout(400);
    await press(page.getByRole("button", { name: "Модель", exact: true }));
    await page.getByRole("listbox", { name: "Модели" }).waitFor();
    await page.waitForTimeout(300);
    if ((await page.locator('[data-offer^="claude/"]').count()) !== 15) throw new Error("в новой сессии список моделей другой");
    await shot("new-models");
    await press(page.locator('[data-offer="orca/glm-5.3"] .mp-pick'));
    await page.getByText("glm-5.3").first().waitFor();
    await page.waitForTimeout(450);
    if (await page.getByLabel(/^(Аккаунт|Очередь аккаунтов)$/).count()) throw new Error("в новой сессии осталось поле аккаунта");
    await shot("new-on-key", { fullPage: true });
  });
  await page.close();
}
await browser.close();
console.log(`${total - bad} из ${total}`);
process.exit(bad ? 1 : 0);
