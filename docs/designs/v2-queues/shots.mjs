// Снимки прототипа «Очереди аккаунтов»: node docs/designs/v2-queues/shots.mjs [адрес=http://localhost:4832] [папка снимков]
// Проходит сценарии в настоящем Chrome на моке: несколько очередей на машине, новая очередь страницей, перенос аккаунта между очередями,
// «Сменить сейчас» у одной очереди, удаление очереди, выбор очереди в форме и в ряду под полем ввода.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../v2");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
const base = process.argv[2] ?? "http://localhost:4832";
const out = process.argv[3] ?? path.join(here, "shots");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
let bad = 0, total = 0;
for (const [w, h] of [[1280, 860], [390, 844]]) for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: w < 500 });
  page.setDefaultTimeout(9000);
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`) });
  const open = async (hash) => { await page.goto(`${base}/#${hash}`); await page.waitForTimeout(700); };
  const step = async (label, fn) => {
    total++;
    try {
      await fn();
      // окон поверх экрана нет: шаги — страницами
      const over = await page.locator('.mantine-Modal-root:visible, .mantine-Drawer-root:visible').count();
      if (over) throw new Error("окно поверх экрана");
      console.log(`✓ ${w} ${theme} · ${label}`);
    } catch (e) { bad++; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  const card = (machine) => page.locator(".card").filter({ has: page.getByText(machine, { exact: true }) }).first();
  const queue = (machine, name) => card(machine).locator(`[data-queue="${name}"]`);
  const order = async (machine, name) => queue(machine, name).locator("[data-drag-id]").evaluateAll((els) => els.map((e) => e.dataset.dragId.split("|")[1]));

  await step("на машине несколько очередей; общий аккаунт показывает один и тот же лимит в обеих", async () => {
    await open("/fleet/accounts");
    await queue("laptop", "main").waitFor();
    await queue("laptop", "review").waitFor();
    const five = async (name) => queue("laptop", name).locator('[data-drag-id$="|yuri@example.com"]').getByText(/^5 ч \d+%$/).textContent();
    if ((await five("main")) !== (await five("review"))) throw new Error("лимит одного аккаунта в двух очередях разный");
    await queue("server", "night").waitFor();
    await shot("queues");
  });

  await step("«+ очередь» — страница шага: имя, аккаунты по порядку; очередь появляется у машины", async () => {
    await card("server").getByRole("button", { name: "+ очередь" }).click();
    await page.waitForFunction(() => /do=queue/.test(location.hash));
    await page.getByLabel("Имя очереди").fill("main");
    await page.getByText("Такая очередь уже есть").waitFor();
    await page.getByLabel("Имя очереди").fill("docs");
    await page.getByRole("checkbox", { name: /ops@example\.com/ }).check();
    await page.getByRole("checkbox", { name: /yuri@example\.com/ }).check();
    await shot("new-queue");
    await page.getByRole("button", { name: "Завести очередь" }).click();
    await queue("server", "docs").waitFor();
    if ((await order("server", "docs")).join() !== "ops@example.com,yuri@example.com") throw new Error("порядок новой очереди: " + (await order("server", "docs")).join());
    if (/do=/.test(page.url())) throw new Error("шаг остался в адресе");
  });

  await step("перенос аккаунта из входов в очередь и между очередями", async () => {
    const drag = async (from, to) => {
      // обе строки — в окне: цель к верху, затем замер
      await to.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(200);
      const a = await from.boundingBox(), b = await to.boundingBox();
      if (a.y + a.height > h || a.y < 0) throw new Error("строка и цель не помещаются в окно разом");
      if (w < 500) {
        // палец: удержание, потом движение
        const cdp = await page.context().newCDPSession(page);
        const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
        await touch("touchStart", a.x + 40, a.y + a.height / 2);
        await page.waitForTimeout(450);
        for (let i = 1; i <= 8; i++) await touch("touchMove", a.x + 40, a.y + a.height / 2 + ((b.y + b.height - 2 - a.y - a.height / 2) * i) / 8);
        await touch("touchEnd", 0, 0);
      } else {
        await page.mouse.move(a.x + 40, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(a.x + 40, a.y + a.height / 2 + 8, { steps: 3 });
        await page.mouse.move(b.x + 40, b.y + b.height - 2, { steps: 8 });
        await page.mouse.up();
      }
      await page.waitForTimeout(500);
    };
    // night@ стоит только во входах сервера и в очереди night: из входов — в docs
    await drag(card("server").locator('[data-drag-id="|night@example.com"]'), queue("server", "docs").locator("[data-drag-id]").last());
    if (!(await order("server", "docs")).includes("night@example.com")) throw new Error("из входов в очередь не встал: " + (await order("server", "docs")).join());
    if (!(await order("server", "night")).includes("night@example.com")) throw new Error("перенос из входов убрал аккаунт из другой очереди");
    // между очередями: ops@ из docs в конец main — из docs уходит
    await drag(queue("server", "docs").locator('[data-drag-id="docs|ops@example.com"]'), queue("server", "main").locator("[data-drag-id]").last());
    if ((await order("server", "docs")).includes("ops@example.com")) throw new Error("после переноса остался в прежней очереди");
    if ((await order("server", "main")).filter((m) => m === "ops@example.com").length !== 1) throw new Error("в целевой очереди аккаунт не один раз: " + (await order("server", "main")).join());
    await shot("moved");
  });

  await step("«Сменить сейчас» меняет аккаунт только своей очереди", async () => {
    const cur = (name) => queue("server", name).locator(".line").filter({ has: page.locator('[aria-label="стоит сейчас"]') }).locator("[data-drag-id], .trunc").first().textContent();
    const wasNight = await cur("night");
    const wasMain = await cur("main");
    await queue("server", "main").getByRole("button", { name: "Сменить сейчас" }).click();
    await page.waitForTimeout(500);
    if ((await cur("main")) === wasMain) throw new Error("очередь main не сменила аккаунт");
    if ((await cur("night")) !== wasNight) throw new Error("очередь night тоже сменилась");
  });

  await step("очередь с сессиями не удаляется; пустая удаляется страницей подтверждения", async () => {
    if (!(await queue("server", "main").getByRole("button", { name: "Удалить очередь main" }).isDisabled())) throw new Error("очередь с сессиями можно удалить");
    await queue("server", "docs").getByRole("button", { name: "Удалить очередь docs" }).click();
    await page.waitForFunction(() => /do=confirm/.test(location.hash));
    await shot("delete-queue");
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    await queue("server", "docs").waitFor({ state: "detached" });
  });

  await step("форма «Новая сессия» называет очередь: очереди машины и ключи, «авто» нет", async () => {
    await open("/new?machine=laptop&cwd=~/projects/site");
    const field = page.getByLabel("Очередь аккаунтов").first();
    await field.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("input")].some((i) => /^main · yuri@example.com/.test(i.value)));
    await field.click();
    const options = await page.getByRole("option").allTextContents();
    if (!options.some((o) => o.startsWith("review · ")) || !options.some((o) => o.startsWith("ключ "))) throw new Error("в выборе нет очередей и ключей: " + options.join(" | "));
    if (options.some((o) => /авто/.test(o))) throw new Error("в выборе осталось «авто»");
    await shot("new-session");
    await page.keyboard.press("Escape");
  });

  await step("чип «очередь» под полем ввода: очередь и кто в ней стоит; смена — выбор другой очереди", async () => {
    await open("/work/site@laptop");
    const chip = page.locator(".composer-opts").getByRole("button", { name: "Очередь" });
    await chip.waitFor();
    if (!/main · yuri@example\.com/.test(await chip.textContent())) throw new Error("чип: " + (await chip.textContent()));
    await chip.click();
    await page.getByRole("menuitem", { name: /^review · / }).click();
    await page.waitForFunction(() => /review/.test(document.querySelector('.composer-opts [aria-label="Очередь"]')?.textContent ?? ""));
    await shot("chip");
  });
  await page.close();
}
await browser.close();
console.log(bad ? `сбоев: ${bad} из ${total}` : `шаги: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
