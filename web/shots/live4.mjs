// Живая проверка наблюдения и находок архива на настоящем флоте: node shots/live4.mjs [флот] [устройство] [порт] [машина]
// «Наблюдение» с числами Host и рядами, экран машины, архив с поиском и переходом к найденной записи, аккаунты. Только чтение:
// пропуск проверки в конце отзывается, ничего другого на флоте не меняется.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fleetEnv } from "../../tools/dev.mjs";
import { chromium, fleetCall } from "../../tools/fleet/harness.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "..");
const [fleet = "test", device = "cli", port = "4836", machine = "devbox"] = process.argv.slice(2);
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const out = path.join(root, "dist", "live4");
fs.mkdirSync(out, { recursive: true });
const { call } = fleetCall(fleet, device);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = spawn("npx", ["vite", "--config", "vite.live.config.ts", "--port", port], { cwd: web, shell: true, env: { ...process.env, SB2_BASE: env.SB2_BASE }, stdio: "pipe" });
const stopVite = () => (process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(vite.pid), "/t", "/f"]) : vite.kill());
const local = "http://localhost:" + port;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(local)).ok) break;
  } catch {}
  await sleep(500);
}

const me = call("whoami", {}).result;
const invite = call("invite", { addr: "w4" + Date.now().toString(36).slice(-4) + me.person }).result;
// что отдаёт сам флот — с этим сверяется экран
const health = call("obs.health", {}).result;
const metrics = call("machine.metrics", { to: "@" + machine });
const series = call("obs.series", { machine, since: Date.now() - 24 * 3_600_000 });
const stats = call("points.stats", {}).result;
const accounts = call("account.list", { to: "@" + machine }).result?.accounts ?? [];
const archived = call("points.list", {}).result?.sessions ?? [];
const WORD = process.env.SB2_WORD ?? "note";
const found = call("points.list", { q: WORD }).result?.sessions ?? [];

const steps = [];
const step = async (label, fn) => {
  const t0 = Date.now();
  try {
    const note = await fn();
    steps.push(`✓ ${label}${note ? " · " + note : ""} · ${Date.now() - t0} мс`);
  } catch (e) {
    steps.push(`✗ ${label} · ${String(e.message).split("\n")[0]}`);
  }
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], refusals = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("response", async (r) => {
  if (!r.url().endsWith("/call")) return;
  const j = await r.json().catch(() => null);
  if (j && j.ok === false) refusals.push(`${JSON.parse(r.request().postData() ?? "{}").type}: ${j.error}`);
});
const at = (hash) => `${local}/?fleet=${encodeURIComponent(local)}#${hash}`;
const shot = (name) => page.screenshot({ path: path.join(out, name + ".png") });

await step("вход по приглашению", async () => {
  await page.goto(`${local}/?fleet=${encodeURIComponent(local)}#invite=${encodeURIComponent(invite.invite)}`);
  await page.getByText("Работа", { exact: true }).first().waitFor({ timeout: 20_000 });
});
await step("«Наблюдение»: строки машин с числами Host в сводке", async () => {
  await page.goto(at("/observe/requests"));
  const hosts = health.hosts ?? [];
  if (!hosts.length) throw new Error("служба не отдала hosts в obs.health");
  for (const h of hosts) await page.getByRole("button", { name: h.machine, exact: true }).first().waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Ряды" }).first().waitFor({ timeout: 5000 });
  await shot("1-observe");
  return `машин с числами ${hosts.length}`;
});
await step("«Наблюдение → Ряды»: три графика машины и запросы флота", async () => {
  await page.goto(at("/observe/series?m=" + machine));
  await page.getByText("Ответ провайдера, мс").waitFor({ timeout: 20_000 });
  await page.getByText("Сессии по состояниям").waitFor({ timeout: 5000 });
  await page.getByText("Запросы флота").waitFor({ timeout: 5000 });
  const rows = series.result?.rows?.length ?? 0;
  if (!rows) throw new Error("служба не отдала ряд за сутки: " + JSON.stringify(series).slice(0, 160));
  await page.waitForFunction(() => document.querySelectorAll(".recharts-surface").length >= 4, null, { timeout: 15_000 });
  await shot("2-series-day");
  await page.getByText("7 дней", { exact: true }).click();
  await page.waitForTimeout(1500);
  await shot("3-series-week");
  return `строк ряда за сутки ${rows}`;
});
await step(`экран машины ${machine}: числа Host и ряды`, async () => {
  if (!metrics.ok) throw new Error("machine.metrics: " + metrics.error);
  await page.goto(at("/machine/" + machine));
  await page.getByText("Числа Host").waitFor({ timeout: 20_000 });
  await page.getByText("Очередь ввода").waitFor({ timeout: 5000 });
  await page.getByText("Ответ провайдера, мс").waitFor({ timeout: 15_000 });
  await shot("4-machine");
  return `очередь ${metrics.result.queue}, вызовов провайдера ${metrics.result.provider.n}`;
});
await step("архив: сводка от службы", async () => {
  await page.goto(at("/archive"));
  await page.getByText(/В архиве \d/).waitFor({ timeout: 20_000 });
  await shot("5-archive");
  return `сессий ${stats.sessions}, точек ${stats.points}, в каталоге ${archived.length}`;
});
await step(`архив: поиск «${WORD}» и переход к найденной записи`, async () => {
  const hit = found.find((s) => s.hitUuid);
  if (!hit) throw new Error(`поиск не назвал запись (найдено ${found.length})`);
  await page.getByLabel("Поиск по архиву").fill(WORD);
  await page.locator(".pane.list .row").first().waitFor({ timeout: 20_000 });
  await page.locator(".pane.list .row").first().click();
  await page.locator("[data-hit]").first().waitFor({ timeout: 30_000 });
  const seen = await page.locator("[data-hit]").first().evaluate((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
  if (!seen) throw new Error("найденная запись есть в ленте, но не на экране");
  await shot("6-archive-hit");
  return `запись ${hit.hitUuid.slice(0, 8)}, точка ${hit.hitPoint ?? "—"}`;
});
await step("аккаунты: время замера и срок входа — настоящие поля", async () => {
  await page.goto(at("/fleet/accounts"));
  await page.getByText(machine, { exact: false }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await shot("7-accounts");
  const claude = accounts.filter((a) => a.kind === "claude");
  const keys = accounts.filter((a) => a.kind === "key");
  return `входов Claude ${claude.length} (с временем замера ${claude.filter((a) => a.at !== undefined || a.limits?.some((l) => l.at !== undefined)).length}, со сроком ${claude.filter((a) => a.expires !== undefined).length}), ключей флота ${keys.length}`;
});

await browser.close();
stopVite();
call("revoke", { kid: invite.kid });
for (const s of steps) console.log(s);
console.log("ошибок страницы:", errors.length, errors.slice(0, 4).join(" | ").slice(0, 500));
console.log("отказов запросов:", refusals.length, [...new Set(refusals)].join(" | ").slice(0, 500));
console.log("снимки:", out);
process.exit(steps.some((s) => s.startsWith("✗")) || errors.length ? 1 : 0);
