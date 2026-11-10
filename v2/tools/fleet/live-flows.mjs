// Живая проверка флоу без окон: node tools/fleet/live-flows.mjs [флот] [устройство] [папка снимков]
// В настоящем Chrome на 1440 и 390: шаги открываются страницами с адресом, «Назад» браузера возвращает на экран, окон поверх экрана нет.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fleetEnv } from "../dev.mjs";
import { chromium, fleetCall } from "./harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [fleet = "test", device = "cli", outArg] = process.argv.slice(2);
const out = outArg ?? path.join(root, "dist", "flows");
fs.mkdirSync(out, { recursive: true });
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const { call } = fleetCall(fleet, device);
const me = call("whoami", {}).result;
const session = call("fleet.list", {}).result.sessions[0]?.callsign;

const browser = await chromium.launch({ channel: "chrome" });
let bad = 0, total = 0;
// окно — видимое; скрытый список выпадающего поля окном не считается
const overlays = '[role="dialog"]:visible, .mantine-Modal-root:visible, .mantine-Drawer-root:visible, .mantine-Popover-dropdown:not(.mantine-Select-dropdown):visible';
const errors = [];
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const invite = call("invite", { addr: "flow" + w + Date.now().toString(36).slice(-4) + me.person }).result;
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("pageerror", (e) => errors.push(`${w}: ${e.message}`));
  await page.goto(`${env.SB2_BASE}/#invite=${encodeURIComponent(invite.invite)}`);
  await page.waitForSelector(w > 860 ? "nav.rail a" : "nav.tabbar a", { timeout: 20_000 });
  const step = async (label, fn) => {
    total++;
    try {
      await fn();
      // окон поверх экрана нет ни на одном шаге
      const over = await page.locator(overlays).count();
      if (over) throw new Error(`окон поверх экрана: ${over} · ${await page.locator(overlays).first().evaluate((e) => e.outerHTML.slice(0, 240))}`);
      console.log(`✓ ${w} · ${label}`);
    } catch (e) {
      bad++;
      console.log(`✗ ${w} · ${label} · ${String(e.message).split("\n")[0]}`);
    }
  };
  const shot = (name) => page.screenshot({ path: path.join(out, `${w}-${name}.png`) });
  const at = (re) => page.waitForFunction((s) => new RegExp(s).test(location.hash), re.source, { timeout: 8000 });
  const title = (name) => page.getByRole("heading", { name }).first().waitFor({ timeout: 8000 });
  const open = async (hash) => { await page.goto(`${env.SB2_BASE}/#${hash}`); await page.waitForTimeout(600); };

  await step("новая сессия — страница", async () => {
    await page.getByRole("button", { name: "Новая сессия" }).first().click();
    await at(/^#\/new/); await title("Новая сессия"); await shot("new");
    await page.goBack(); await page.waitForFunction(() => !location.hash.startsWith("#/new"));
  });
  await step("найти — страница", async () => {
    await open("/find"); await title("Найти");
    await page.getByRole("textbox", { name: "Найти" }).fill("машин");
    await page.getByRole("option").first().waitFor(); await shot("find");
  });
  await step("добавить машину — шаг и назад", async () => {
    await open("/fleet/machines");
    await page.getByRole("button", { name: /Добавить машину/ }).click();
    await at(/do=add/); await title("Добавить машину"); await shot("add-machine");
    await page.goBack();
    await page.waitForFunction(() => !/do=/.test(location.hash) && !document.querySelector("[data-step]"));
  });
  await step("ключ флота — шаг, закрытие кнопкой убирает адрес шага", async () => {
    await open("/fleet/accounts");
    await page.getByRole("button", { name: "Добавить ключ" }).first().click();
    await at(/do=key/); await shot("key");
    await page.locator("[data-step] header").getByRole("button", { name: "Назад" }).click();
    await page.waitForFunction(() => !/do=/.test(location.hash) && !document.querySelector("[data-step]"));
    if (!/#\/fleet\/accounts$/.test(page.url())) throw new Error("адрес после закрытия: " + page.url());
  });
  await step("аккаунты — очереди машины строками; «+ очередь» — страница шага", async () => {
    await open("/fleet/accounts");
    await page.getByText("main", { exact: true }).first().waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "+ очередь" }).first().click();
    await at(/do=queue/); await title(/^Новая очередь на /);
    await page.getByRole("textbox", { name: "Имя очереди" }).waitFor(); await shot("queue-new");
    await page.goBack();
    await page.waitForFunction(() => !/do=/.test(location.hash) && !document.querySelector("[data-step]"));
    await shot("queues");
  });
  await step("пригласить устройство — форма, затем ссылка", async () => {
    await open("/settings/passes");
    await page.getByRole("button", { name: "Выдать приглашение" }).waitFor();
    await page.getByRole("textbox", { name: "Имя устройства" }).fill("flowtest" + w);
    await page.getByRole("button", { name: "Выдать приглашение" }).click();
    await at(/do=link/); await shot("invite-link");
    await page.getByRole("button", { name: "Готово" }).click();
    await page.waitForFunction(() => !document.querySelector("[data-step]"));
  });
  if (session) {
    await step("удалить сессию — страница подтверждения, отмена", async () => {
      await open("/work/" + session);
      await page.locator(".composer-opts").getByRole("button", { name: "Ещё" }).first().click();
      await page.getByRole("menuitem", { name: "Убрать сессию" }).click();
      await at(/do=confirm/); await shot("confirm");
      await page.getByRole("button", { name: "Отмена" }).click();
      await page.waitForFunction(() => !/do=/.test(location.hash) && !document.querySelector("[data-step]"));
    });
    if (w < 861) await step("сведения о сессии — страница", async () => {
      await open("/work/" + session);
      await page.getByRole("button", { name: "Инспектор" }).click();
      await at(/do=info/); await shot("info");
      await page.goBack();
      await page.waitForFunction(() => !document.querySelector("[data-step]"));
    });
  }
  if (w < 861) await step("ещё — страница", async () => {
    await open("/inbox");
    await page.locator("nav.tabbar").getByText("Ещё").click();
    await at(/^#\/more/); await title("Ещё"); await shot("more");
  });
  await step("новая сессия — один уровень, кусочки показывают свои поля", async () => {
    await open("/new");
    if (await page.getByRole("button", { name: /Скрыть настройки|Модель, аккаунт/ }).count()) throw new Error("настройки спрятаны");
    await page.getByLabel("Размышлять перед ответом").waitFor();
    await page.getByText("reviewer", { exact: true }).click();
    await page.locator('[aria-label="Что ставят кусочки"]').getByText("claude-opus-5-5").waitFor({ timeout: 8000 });
    await shot("new-flat");
  });
  await step("галочка проекта в «Людях» — без полосы «нет связи»", async () => {
    await open("/settings/people");
    const box = page.getByRole("checkbox").first();
    await box.waitFor();
    let bars = 0;
    const watch = setInterval(async () => { bars += await page.getByText("Нет связи с флотом").count().catch(() => 0); }, 100);
    await box.click(); await page.waitForTimeout(1500);
    await box.click(); await page.waitForTimeout(1500);
    clearInterval(watch);
    if (bars) throw new Error("полоса «нет связи» показалась");
  });
  await step("ClickHouse — состояние в «Наблюдении»", async () => {
    await open("/observe/analytics");
    await page.getByText(/^отвечает · /).waitFor({ timeout: 10_000 });
    await page.getByText("точек архива ждут долива").waitFor(); await shot("clickhouse");
  });
  if (session) await step("чипы документа — под полем ввода", async () => {
    await open("/work/" + session);
    await page.locator(".composer-opts").getByRole("button", { name: "Режим" }).waitFor({ timeout: 8000 });
    if (await page.locator(".conv-head").getByRole("button", { name: "Модель" }).count()) throw new Error("чипы остались в шапке");
    await shot("chips");
  });
  if (w > 860) await step("вид списка — окошко, список меняется сразу", async () => {
    await open("/work");
    await page.getByRole("button", { name: "Вид списка" }).click();
    await page.getByLabel("Время").waitFor();
    if (/do=look/.test(page.url())) throw new Error("вид списка открылся страницей");
    await shot("look"); await page.getByRole("button", { name: "Вид списка" }).click(); await page.getByLabel("Время").waitFor({ state: "hidden", timeout: 5000 });
  });
  await step("клавиши — страница", async () => { await open("/keys"); await title("Клавиши"); });
  await page.close();
}
await browser.close();
if (errors.length) console.log("ошибки страницы:\n" + [...new Set(errors)].join("\n"));
console.log(bad || errors.length ? `сбоев: ${bad} из ${total}` : `флоу: ${total} из ${total}`);
process.exit(bad || errors.length ? 1 : 0);
