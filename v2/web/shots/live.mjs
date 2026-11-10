// Живой проход экранов на настоящем флоте: node shots/live.mjs [флот] [устройство с пропуском] [порт] [часть имени экрана]
// Поднимает локальную сборку страницы с проходом запросов на адрес флота, принимает приглашение в браузере и открывает каждый экран;
// печатает по экрану: открылся ли, отказы запросов, ошибки страницы. Только чтение: кнопки, меняющие флот, не нажимаются.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fleetEnv } from "../../tools/dev.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "..");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
const [fleet = "test", device = "cli", port = "4831", only] = process.argv.slice(2);
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const out = path.join(root, "dist", "live-screens");
fs.mkdirSync(out, { recursive: true });
const call = (type, fields) => JSON.parse(execFileSync(process.execPath, [path.join(root, "tools/fleet/call.ts"), fleet, device, type, JSON.stringify(fields)], { cwd: root }).toString());

const vite = spawn("npx", ["vite", "--config", "vite.live.config.ts", "--port", port], { cwd: web, shell: true, env: { ...process.env, SB2_BASE: env.SB2_BASE }, stdio: "pipe" });
const stopVite = () => (process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(vite.pid), "/t", "/f"]) : vite.kill());
const local = "http://localhost:" + port;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(local)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const me = call("whoami", {}).result;
const name = "walk" + Date.now().toString(36).slice(-5);
const invite = call("invite", { addr: name + me.person }).result;
const machine = me.machines[0] ?? "devbox";

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
let errors = [], refused = [];
page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon/.test(m.text()) && errors.push(m.text().split("\n")[0].slice(0, 200)));
page.on("response", async (r) => {
  if (!r.url().endsWith("/call")) return;
  try {
    const j = await r.json();
    if (j && j.ok === false) refused.push(`${JSON.parse(r.request().postData() ?? "{}").type}: ${j.error}${j.why ? ` — ${String(j.why).slice(0, 90)}` : ""}`);
  } catch {}
});

const rows = [];
async function screen(label, hash, act) {
  if (only && !label.includes(only)) return;
  errors = [];
  refused = [];
  let opened = true, note = "";
  try {
    if (hash) await page.goto(`${local}/?fleet=${local}#${hash}`);
    await page.waitForTimeout(1800);
    if (act) note = (await act()) ?? "";
    await page.waitForTimeout(700);
    const text = await page.evaluate(() => (document.querySelector(".page, .panes, main") ?? document.body).innerText.trim());
    if (text.length < 20) {
      opened = false;
      note = "пустой экран";
    } else if (/Не получилось|Экран не открылся|Что-то сломалось/.test(text)) note = (note ? note + "; " : "") + "на экране сообщение об ошибке";
  } catch (e) {
    opened = false;
    note = String(e.message).split("\n")[0].slice(0, 140);
  }
  await page.screenshot({ path: path.join(out, label.replace(/[^a-zа-я0-9]+/gi, "-") + ".png") }).catch(() => {});
  rows.push({ label, opened, refused: [...new Set(refused)], errors: [...new Set(errors)], note });
}
const click = async (role, nameRe) => {
  const el = page.getByRole(role, { name: nameRe }).first();
  await el.waitFor({ timeout: 6000 });
  await el.click();
};

await page.goto(`${local}/?fleet=${local}#invite=${encodeURIComponent(invite.invite)}`);
await page.getByText("Работа", { exact: true }).first().waitFor({ timeout: 25_000 });

await screen("Флот: машины", "/fleet/machines");
await screen("Машина", "/machine/" + machine);
await screen("Флот: аккаунты", "/fleet/accounts");
await screen("Флот: профили", "/fleet/profiles");
await screen("Флот: выпуски", "/fleet/releases");
await screen("Флот: инциденты", "/fleet/incidents");
await screen("Архив: каталог", "/archive");
await screen("Архив: поиск", "", async () => {
  await page.getByLabel("Поиск по архиву").fill("note");
  await page.waitForTimeout(1500);
  return `строк: ${await page.locator(".pane.list .row").count()}`;
});
await screen("Архив: сессия и точки", "", async () => {
  await page.locator(".pane.list .row").first().click();
  await page.waitForTimeout(2500);
  return `точек: ${await page.locator(".pt").count()}, кусков ленты: ${await page.locator(".feed-in > div").count()}`;
});
await screen("Архив: вызовы модели", "", async () => {
  await click("button", /Действия с сессией архива/);
  await click("menuitem", /Вызовы модели/);
  await page.waitForTimeout(2000);
  const n = await page.locator(".mantine-Modal-body tbody tr").count();
  await page.keyboard.press("Escape");
  return `вызовов: ${n}`;
});
await screen("Расход", "/spend");
await screen("Наблюдение: запросы", "/observe");
await screen("Наблюдение: разбор запроса", "", async () => {
  await page.locator("tbody tr").first().click();
  return "";
});
await screen("Наблюдение: журнал флота", "/observe/ledger");
await screen("Наблюдение: журнал машины", "/observe/machine?m=" + machine);
await screen("Настройки: люди и проекты", "/settings/people");
await screen("Настройки: пропуска", "/settings/passes");
await screen("Настройки: уведомления", "/settings/alerts");
await screen("Настройки: правила прокси", "/settings/proxy");
await screen("Настройки: сбои и цены", "/settings/fleet");
await screen("Настройки: GitHub", "/settings/github");
await screen("Настройки: имена", "/settings/names");
await screen("Настройки: это устройство", "/settings/device");
await screen("Палитра", "/fleet/machines", async () => {
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(600);
  await page.keyboard.type("dev");
  await page.waitForTimeout(600);
  const n = await page.locator(".mantine-Spotlight-action").count();
  await page.keyboard.press("Escape");
  return `строк палитры: ${n}`;
});

await browser.close();
stopVite();
call("revoke", { kid: invite.kid });
for (const r of rows) console.log(`${r.opened ? "✓" : "✗"} ${r.label}${r.note ? ` · ${r.note}` : ""}${r.refused.length ? `\n    отказы: ${r.refused.join(" | ")}` : ""}${r.errors.length ? `\n    ошибки: ${r.errors.join(" | ")}` : ""}`);
const bad = rows.filter((r) => !r.opened || r.refused.length || r.errors.length).length;
console.log(`экранов ${rows.length}, с замечаниями ${bad}; снимки: ${out}`);
process.exit(0);
