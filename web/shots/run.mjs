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

// порт и папка сборки — из окружения: два прогона рядом не мешают друг другу (SHOTS_PORT, SHOTS_DIST)
const port = Number(process.env.SHOTS_PORT ?? 4821);
const dist = process.env.SHOTS_DIST ?? "dist";
await build({ root: web, logLevel: "error", build: { outDir: dist } });
const server = await preview({ root: web, preview: { port, strictPort: true }, build: { outDir: dist }, logLevel: "error" });
const base = `http://localhost:${port}/?still`;

const click = (text) => async (p) => void (await p.getByText(text, { exact: true }).first().click());
const key = (k) => async (p) => void (await p.keyboard.press(k));

/** имя, путь, действия после загрузки, только широкий или только узкий */
const SHOTS = [
  ["inbox", "/inbox"],
  ["inbox-question", "/inbox/site-tests@laptop"],
  ["inbox-done", "/inbox/docs@laptop"],
  ["work", "/work"],
  ["work-session", "/work/site@laptop"],
  ["work-board", "/work", async (p) => { await p.getByLabel("Вид списка").first().click(); await p.getByText("Доска", { exact: true }).click(); await p.keyboard.press("Escape"); }, "wide"],
  ["work-view", "/work", async (p) => { await p.getByLabel("Вид списка").first().click(); await p.getByText("Список", { exact: true }).click({ timeout: 1500 }).catch(() => {}); await p.getByText("По машинам", { exact: true }).click(); }],
  ["work-tree", "/work", async (p) => { await p.getByLabel("Вид списка").first().click(); await p.getByText("По проектам", { exact: true }).click(); await p.keyboard.press("Escape"); await p.getByLabel("Фильтр списка").click(); await p.getByRole("menuitem", { name: "Все" }).click(); }],
  ["session-permission", "/work/deploy@server"],
  ["session-plan", "/work/api@server"],
  ["session-form", "/work/forms@anya-pc"],
  ["session-failed", "/work/hotfix@laptop"],
  ["session-tool-open", "/work/docs@laptop", async (p) => void (await p.locator("button.tool").first().click().catch(() => {}))],
  ["session-pair-info", "/work/lead@laptop", async (p) => void (await p.getByRole("radiogroup", { name: "Кого показать" }).getByText("ведущий", { exact: true }).click()), "wide"],
  ["session-pair-log", "/work/lead@laptop", click("Журнал"), "wide"],
  ["session-pair", "/work/lead@laptop", async (p) => void (await p.getByRole("radiogroup", { name: "Кого показать" }).getByText("обе", { exact: true }).click()), "wide"],
  ["session-pair-phone", "/work/lead@laptop", async (p) => void (await p.getByRole("radiogroup", { name: "Кого показать" }).getByText("▸ ведомый", { exact: true }).click()), "narrow"],
  ["session-head-parts", "/work/site@laptop", async (p) => { await p.getByLabel("Ещё").first().click(); await p.getByText("Шапка", { exact: true }).hover(); await p.getByRole("menuitem", { name: "Машина" }).click(); }, "wide"],
  ["session-name", "/work/site@laptop", async (p) => void (await p.getByTitle("Назвать сессию").first().click()), "wide"],
  ["session-inspector-context", "/work/site@laptop", click("Контекст"), "wide"],
  ["session-inspector-points", "/work/site@laptop", click("Точки"), "wide"],
  ["session-model-menu", "/work/site@laptop", async (p) => void (await p.getByLabel("Модель").first().click()), "wide"],
  ["session-sheet", "/work/site@laptop", async (p) => void (await p.getByLabel("Инспектор").first().click()), "narrow"],
  ["session-offline", "/work/crawler@base2"],
  ["session-queued", "/work/site@laptop", async (p) => { const box = p.getByLabel("Сообщение сессии"); await box.fill("И подвал тоже проверь на 390"); await box.press("Enter"); }],
  ["session-focus", "/work/site@laptop", async (p) => { await p.getByLabel("Ещё").first().click(); await p.getByText("Фокус: только итоги ходов").click(); }, "wide"],
  ["session-background", "/work/ingest@server", async (p) => void (await p.getByText("Вывод", { exact: true }).first().click())],
  ["session-inspector-files", "/work/site@laptop", click("Файлы"), "wide"],
  ["session-inspector-log", "/work/hotfix@laptop", click("Почему"), "wide"],
  ["session-deny", "/work/deploy@server", async (p) => void (await p.locator(".askcard:not(.inline)").getByText("Отклонить", { exact: true }).click())],
  ["session-commands", "/work/docs@laptop", async (p) => void (await p.getByLabel("Сообщение сессии").fill("/"))],
  ["inbox-answered", "/inbox/site-tests@laptop", async (p) => void (await p.locator(".askcard:not(.inline)").getByText("release/2.4", { exact: true }).click())],
  ["machine-offline", "/machine/base2"],
  ["machine-online", "/machine/server"],
  ["fleet-releases-confirm", "/fleet/releases", async (p) => { await p.getByText("Сборки", { exact: true }).click(); await p.getByText("Откатить флот сюда").first().click(); }],
  ["fleet-releases-builds", "/fleet/releases", async (p) => void (await p.getByText("Сборки", { exact: true }).click())],
  ["fleet-releases-picked", "/fleet/releases", async (p) => { await p.getByText("По машинам", { exact: true }).click(); await p.getByRole("checkbox", { name: "Выбрать laptop" }).check(); await p.getByRole("checkbox", { name: "Выбрать server" }).check(); await p.getByRole("button", { name: "Закрепить выбранные…" }).click(); }],
  ["fleet-accounts-marked", "/fleet/accounts", async (p) => { await p.locator(".linklike").first().click(); await p.locator(".warnmark").first().click().catch(() => {}); }],
  ["archive-branch", "/archive", async (p) => { await p.locator(".pane.list .row").first().click(); await p.waitForTimeout(900); }],
  ["fleet-releases-rollout", "/fleet/releases", async (p) => { await p.getByText("Сборки", { exact: true }).click(); await p.getByText("Откатить флот сюда").first().click(); await p.getByRole("button", { name: "Откатить флот", exact: true }).click(); await p.waitForTimeout(1800); }],
  ["settings-passes-confirm", "/settings/passes", async (p) => void (await p.getByRole("button", { name: "Отозвать" }).nth(1).click())],
  ["archive-live", "/archive", async (p) => { await p.getByLabel("Поиск по архиву").fill("шапка"); await p.waitForTimeout(500); await p.locator(".pane.list .row").first().click(); await p.waitForTimeout(600); }],
  ["new-session", "/work", key("n")],
  ["new-session-more", "/work", async (p) => { await p.keyboard.press("n"); await p.getByText("Модель, аккаунт, кусочки, проект").click(); }],
  ["palette", "/inbox", async (p) => { await p.keyboard.press("Control+k"); await p.keyboard.type("site"); }, "wide"],
  ["keys", "/inbox", key("Shift+?"), "wide"],
  ["archive", "/archive"],
  ["archive-search", "/archive", async (p) => { await p.getByLabel("Поиск по архиву").fill("шапка"); await p.waitForTimeout(500); }],
  ["archive-hit", "/archive", async (p) => { await p.getByLabel("Поиск по архиву").fill("шапка"); await p.waitForTimeout(600); await p.locator(".pane.list .row").first().click({ force: true }); await p.waitForTimeout(1200); }],
  ["archive-session", "/archive", async (p) => { await p.getByLabel("Поиск по архиву").fill("шапка"); await p.waitForTimeout(500); await p.locator(".pane.list .row").first().click(); }],
  ["spend", "/spend"],
  ["spend-down", "/spend", async (p) => { await p.evaluate(() => window.__mock.setAnalyticsDown(true)); await p.getByText("30 дней").click(); }],
  ["fleet-machines", "/fleet/machines"],
  ["fleet-add-machine", "/fleet/machines", click("Добавить машину"), "wide"],
  ["fleet-accounts", "/fleet/accounts"],
  ["fleet-login", "/fleet/accounts", async (p) => { await p.getByRole("button", { name: "Войти", exact: true }).first().click(); await p.getByText("Получить ссылку входа").click(); }, "wide"],
  ["fleet-profiles", "/fleet/profiles"],
  ["fleet-releases", "/fleet/releases", async (p) => void (await p.getByText("По машинам", { exact: true }).click())],
  ["fleet-incidents", "/fleet/incidents"],
  ["observe", "/observe/requests"],
  ["observe-failed", "/observe/requests", async (p) => { await p.getByRole("switch").first().check({ force: true }); await p.waitForTimeout(600); await p.locator("tbody tr").first().click({ force: true }); }],
  ["observe-series", "/observe/series", async (p) => { await p.waitForTimeout(900); }],
  ["observe-series-week", "/observe/series", async (p) => { await p.getByText("7 дней", { exact: true }).click(); await p.waitForTimeout(1200); }],
  ["observe-ledger", "/observe/ledger"],
  ["observe-machine", "/observe/machine"],
  ["settings-people", "/settings/people"],
  ["settings-passes", "/settings/passes"],
  ["settings-alerts", "/settings/alerts"],
  ["settings-proxy", "/settings/proxy"],
  ["settings-github", "/settings/github"],
  ["settings-names", "/settings/names"],
  ["more", "/inbox", click("Ещё"), "narrow"],
  // экраны второй волны: фильтры и проекты «Работы», аккаунты и ключи, профили, архив, инциденты, настройки, согласие
  ["work-filters", "/work", async (p) => { await p.getByLabel("Фильтр списка").click(); await p.getByText("Свои фильтры…").click(); await p.getByText("Новый фильтр").click(); }],
  ["work-project-menu", "/work", async (p) => { await p.getByLabel("Вид списка").first().click(); await p.getByText("Список", { exact: true }).click(); await p.keyboard.press("Escape"); await p.getByLabel("Действия с проектом Сайт").click({ force: true }); }, "wide"],
  ["fleet-account-menu", "/fleet/accounts", async (p) => void (await p.getByLabel("Действия: ops@example.com").first().click())],
  ["fleet-key-form", "/fleet/accounts", async (p) => { await p.getByLabel("Действия: ключ orca-glm").click(); await p.getByText("Изменить", { exact: true }).click(); }],
  ["fleet-key-remove", "/fleet/accounts", async (p) => { await p.getByLabel("Действия: ключ meta-muse").click(); await p.getByText("Удалить…").click(); }, "wide"],
  ["fleet-profiles-settings", "/fleet/profiles", async (p) => { await p.getByText("Веб", { exact: true }).click(); await p.getByText("Эксплуатация", { exact: true }).click(); await p.getByRole("button", { name: "Что в наборе" }).click({ timeout: 1500 }).catch(() => {}); await p.getByRole("tab", { name: "Настройки" }).click(); }],
  ["fleet-profiles-files", "/fleet/profiles", async (p) => void (await p.getByRole("tab", { name: "Файлы" }).click()), "wide"],
  ["fleet-profiles-repos", "/fleet/profiles", click("Репозитории")],
  ["fleet-incident-kind", "/fleet/incidents", async (p) => void (await p.getByLabel("Изменить вид disk").click()), "wide"],
  ["fleet-machine-invite", "/fleet/machines", async (p) => { await p.getByText("Добавить машину").click(); await p.getByLabel("Имя машины").fill("tower"); await p.getByText("Выдать приглашение").click(); }, "wide"],
  ["machine-fire", "/machine/base2", click("Поднять её сессии на другой машине")],
  ["archive-point", "/archive/s3e8", async (p) => void (await p.locator(".insp .timeline .pt").nth(2).click()), "wide"],
  ["archive-raise", "/archive/s535", async (p) => { await p.getByRole("button", { name: "Поднять…" }).click(); await p.getByText("Проверить папку").click(); }],
  ["archive-move", "/archive/s3e8", async (p) => { await p.getByLabel("Действия с сессией архива").click(); await p.getByText("Перенести на машину…").click(); }, "wide"],
  ["archive-calls", "/archive/s3e8", async (p) => { await p.getByLabel("Действия с сессией архива").click(); await p.getByText("Вызовы модели").click(); }],
  ["archive-delete", "/archive/s535", async (p) => { await p.getByLabel("Действия с сессией архива").click(); await p.getByText("Удалить из архива…").click(); }, "wide"],
  ["archive-points-phone", "/archive/s3e8", click("Точки"), "narrow"],
  ["settings-people-menu", "/settings/people", async (p) => void (await p.getByLabel("Действия: Аня").click()), "wide"],
  ["settings-invite-qr", "/settings/passes", click("Выдать приглашение")],
  ["settings-telegram", "/settings/alerts", click("Привязать свой чат"), "wide"],
  ["settings-proxy-edit", "/settings/proxy", async (p) => { await p.getByText("Изменить", { exact: true }).nth(1).click(); await p.getByText("Проверить", { exact: true }).click(); }],
  ["settings-fleet", "/settings/fleet"],
  ["settings-device", "/settings/device"],
  ["consent", "path:/consent?still&client_id=https://claude.ai/oauth/client.json&redirect_uri=https://claude.ai/api/mcp/auth_callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&state=s1"],
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
      await page.goto(route.startsWith("path:") ? `http://localhost:${port}${route.slice(5)}` : `${base}#${route}`);
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
