// Снимки экранов страницы на моке флота: 1440 и 390, светлая и тёмная тема. node shots/run.mjs [часть имени]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..");
const out = path.join(web, "..", "docs", "ux", "shots");
const only = process.argv[2] ?? "";
fs.mkdirSync(out, { recursive: true });

await build({ root: web, logLevel: "error" });
const server = await preview({ root: web, preview: { port: 4821, strictPort: true }, logLevel: "error" });
const base = "http://localhost:4821/?still";

const click = (text) => async (p) => void (await p.getByText(text, { exact: true }).first().click());
const key = (k) => async (p) => void (await p.keyboard.press(k));

/** имя, путь, действия после загрузки, только широкий или только узкий */
const SHOTS = [
  ["inbox", "/inbox"],
  ["inbox-question", "/inbox/site-tests@laptop"],
  ["inbox-done", "/inbox/docs@laptop"],
  ["work", "/work"],
  ["work-session", "/work/site@laptop"],
  ["work-board", "/work", click("Доска"), "wide"],
  ["session-permission", "/work/deploy@server"],
  ["session-plan", "/work/api@server"],
  ["session-form", "/work/forms@anya-pc"],
  ["session-failed", "/work/hotfix@laptop"],
  ["session-tool-open", "/work/docs@laptop", async (p) => void (await p.locator("button.tool").first().click().catch(() => {}))],
  ["session-pair", "/work/lead@laptop", async (p) => void (await p.getByLabel("Пара рядом").first().click()), "wide"],
  ["session-inspector-context", "/work/site@laptop", click("Контекст"), "wide"],
  ["session-inspector-points", "/work/site@laptop", click("Точки"), "wide"],
  ["session-model-menu", "/work/site@laptop", async (p) => void (await p.getByLabel("Модель").first().click()), "wide"],
  ["session-sheet", "/work/site@laptop", async (p) => void (await p.getByLabel("Инспектор").first().click()), "narrow"],
  ["session-offline", "/work/crawler@base2"],
  ["session-queued", "/work/site@laptop", async (p) => { const box = p.getByLabel("Сообщение сессии"); await box.fill("И подвал тоже проверь на 390"); await box.press("Enter"); }],
  ["inbox-answered", "/inbox/site-tests@laptop", async (p) => void (await p.locator(".askcard:not(.inline)").getByText("release/2.4", { exact: true }).click())],
  ["machine-offline", "/machine/base2"],
  ["machine-online", "/machine/server"],
  ["fleet-releases-confirm", "/fleet/releases", async (p) => void (await p.getByText("Откатить флот сюда").first().click())],
  ["fleet-releases-rollout", "/fleet/releases", async (p) => { await p.getByText("Откатить флот сюда").first().click(); await p.getByRole("button", { name: "Откатить флот", exact: true }).click(); await p.waitForTimeout(1800); }],
  ["settings-passes-confirm", "/settings/passes", async (p) => void (await p.getByRole("button", { name: "Отозвать" }).nth(1).click())],
  ["archive-live", "/archive", async (p) => { await p.getByLabel("Поиск по архиву").fill("шапка"); await p.waitForTimeout(500); await p.locator(".pane.list .row").first().click(); await p.waitForTimeout(600); }],
  ["new-session", "/work", key("n")],
  ["new-session-more", "/work", async (p) => { await p.keyboard.press("n"); await p.getByText("Модель, кусочки, проект").click(); }],
  ["palette", "/inbox", async (p) => { await p.keyboard.press("Control+k"); await p.keyboard.type("site"); }, "wide"],
  ["keys", "/inbox", key("Shift+?"), "wide"],
  ["archive", "/archive"],
  ["archive-search", "/archive", async (p) => { await p.getByLabel("Поиск по архиву").fill("шапка"); await p.waitForTimeout(500); }],
  ["archive-session", "/archive", async (p) => { await p.getByLabel("Поиск по архиву").fill("шапка"); await p.waitForTimeout(500); await p.locator(".pane.list .row").first().click(); }],
  ["spend", "/spend"],
  ["spend-down", "/spend", async (p) => { await p.evaluate(() => window.__mock.setAnalyticsDown(true)); await p.getByText("30 дней").click(); }],
  ["fleet-machines", "/fleet/machines"],
  ["fleet-add-machine", "/fleet/machines", click("Добавить машину"), "wide"],
  ["fleet-accounts", "/fleet/accounts"],
  ["fleet-login", "/fleet/accounts", async (p) => { await p.getByText("Войти в аккаунт Claude").first().click(); await p.getByText("Получить ссылку входа").click(); }, "wide"],
  ["fleet-profiles", "/fleet/profiles"],
  ["fleet-releases", "/fleet/releases"],
  ["fleet-incidents", "/fleet/incidents", null, "wide"],
  ["observe", "/observe/requests"],
  ["observe-failed", "/observe/requests", async (p) => { await p.getByRole("switch").first().check({ force: true }); await p.waitForTimeout(600); await p.locator("tbody tr").first().click({ force: true }); }],
  ["observe-ledger", "/observe/ledger", null, "wide"],
  ["observe-machine", "/observe/machine", null, "wide"],
  ["settings-people", "/settings/people"],
  ["settings-passes", "/settings/passes"],
  ["settings-alerts", "/settings/alerts", null, "wide"],
  ["settings-proxy", "/settings/proxy"],
  ["settings-github", "/settings/github", null, "wide"],
  ["settings-names", "/settings/names", null, "wide"],
  ["more", "/inbox", click("Ещё"), "narrow"],
].filter(([name]) => name.includes(only));

const browser = await chromium.launch({ channel: "chrome" });
const problems = [];
let n = 0;
for (const [w, h, size] of [[1440, 900, "wide"], [390, 844, "narrow"]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: scheme, locale: "ru-RU" });
    await ctx.addInitScript((s) => localStorage.setItem("mantine-color-scheme-value", s), scheme);
    for (const [name, route, act, onlySize] of SHOTS) {
      if (onlySize && onlySize !== size) continue;
      const page = await ctx.newPage();
      page.on("pageerror", (e) => problems.push(`${name} ${w} ${scheme}: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && !/favicon|fonts\.g/.test(m.text()) && problems.push(`${name} ${w} ${scheme}: console: ${m.text().slice(0, 200)}`));
      await page.goto(`${base}#${route}`);
      await page.waitForTimeout(900);
      try {
        if (act) await act(page);
      } catch (e) {
        problems.push(`${name} ${w} ${scheme}: действие: ${String(e.message).split("\n")[0]}`);
      }
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) problems.push(`${name} ${w} ${scheme}: горизонтальная прокрутка ${over}px`);
      // на телефоне вбок не должно ехать ничего: ни страница, ни отдельный блок внутри неё
      if (size === "narrow" && scheme === "light") {
        const inner = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && /(auto|scroll)/.test(getComputedStyle(el).overflowX) && !el.closest("[aria-hidden=true]")).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")} ${el.scrollWidth}>${el.clientWidth}`).slice(0, 4));
        for (const x of inner) problems.push(`${name} ${w}: едет вбок ${x}`);
      }
      await page.screenshot({ path: path.join(out, `${name}.${w}.${scheme}.png`) });
      n++;
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
await new Promise((r) => server.httpServer.close(r));
console.log(JSON.stringify({ shots: n, problems }, null, 1));
process.exit(0);
