// Снимки чата настоящего кода: галерея всех карточек по разделам и все окна живого экрана — пульт и телефон, светлая и тёмная.
// node scripts/shots/chat.mjs [часть имени снимка]; снимки смотрит глазами тот, кто запустил; замечания — выход за край и ошибки страницы.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { errorsOf, snap } from "./kit.mjs";
import { launch, OUT as ROOT, prepare, url } from "./stand.mjs";

const OUT = path.join(ROOT, "chat");
mkdirSync(OUT, { recursive: true });
await prepare();
const filter = process.argv[2] || "";

const pause = (p, ms = 250) => p.waitForTimeout(ms);
const chat = (cs) => `#chat?callsign=${encodeURIComponent(cs)}`;
const type = async (p, text) => {
  await p.fill(".chat-inp", text);
  await pause(p, 300);
};
const attach = (p) =>
  p.setInputFiles('.chat input[type="file"]', [
    { name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("отчёт") },
    { name: "shot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64") },
  ]);

/** Окна живого экрана: адрес и что сделать перед снимком. */
/** Запрос разрешения и план: кадр и строка инструмента в ленте; узко — полоса, по ней экран. */
const PERM = { question: "toolu_perm", from: "tests@wsl", kind: "perm", tool: "Bash", input: { command: "npm run deploy -- --target=test", description: "Выкладка на тестовый флот" }, title: "Claude хочет выполнить npm run deploy", reason: "Нет правила для этой команды", blockedPath: "~/projects/switchboard/dist", suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run deploy:*" }], behavior: "allow", destination: "localSettings" }] };
const PLAN = { question: "toolu_plan", from: "tests@wsl", kind: "perm", tool: "ExitPlanMode", input: { plan: "## План\n\nСборка падает на **таймауте** эталона 4187.\n\n1. Поднять `testTimeout` до 15 с\n2. Прогнать эталоны\n3. Обновить README\n\n| Шаг | Файл |\n|---|---|\n| 1 | `vitest.config.ts` |\n| 3 | `README.md` |" } };
const ask = async (p, q) => { await p.evaluate((x) => window.__ask(x), q); await pause(p, 350); };
const toScreen = async (p) => { if (await p.locator(".chat-askbar").count()) { await p.click(".chat-askbar"); await pause(p, 350); } };
const WINDOWS = [
  ["idle", "tests@wsl"],
  ["busy", "refactor@win"],
  ["waiting", "migrate@win"],
  ["failed", "night@wsl"],
  ["stopped", "bot@win11-2"],
  ["empty", "home@win"],
  ["typed", "tests@wsl", async (p) => type(p, "Прогони эталоны на тестовом флоте,\nпотом собери отчёт одной строкой\nи выложи")],
  ["commands", "tests@wsl", async (p) => type(p, "/")],
  ["files", "tests@wsl", async (p) => type(p, "Сравни с @src")],
  ["attachments", "tests@wsl", async (p) => { await attach(p); await pause(p); await type(p, "Смотри снимок"); }],
  ["sent", "tests@wsl", async (p) => { await type(p, "Задеплой на стенд"); await p.click(".chat-send"); await pause(p); }],
  ["suggestion", "tests@wsl", async (p) => { await p.evaluate(() => window.relay.push({ type: "session.events", from: "tests@wsl", seq: 900, events: [{ type: "prompt_suggestion", suggestion: "Закоммить правку и выложи на тестовый флот" }] })); await pause(p); }],
  ["streaming", "refactor@win", async (p) => { await p.evaluate(() => window.relay.push({ type: "session.events", from: "refactor@win", seq: 901, events: [{ type: "stream_event", event: { type: "message_start", message: { id: "m-live" } } }, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Пишу итог: **сборка зелёная**, осталось обновить" } } }] })); await pause(p); }],
  ["todo-open", "refactor@win", async (p) => { await p.click(".chat-todo .dis-h"); await pause(p); }],
  ["background-open", "refactor@win", async (p) => { await p.click(".chat-bg .dis-h"); await pause(p); }],
  ["side-wait", "tests@wsl", async (p) => { await type(p, "/btw это долго?"); await p.click(".chat-send"); await pause(p); }],
  ["side-answer", "tests@wsl", async (p) => { await type(p, "/btw какая версия?"); await p.click(".chat-send"); await pause(p); }],
  ["side-refused", "tests@wsl", async (p) => { await type(p, "/btw нельзя?"); await p.click(".chat-send"); await pause(p); }],
  ["btw-hint", "tests@wsl", async (p) => type(p, "/b")],
  ["task-output", "refactor@win", async (p) => { await p.click(".chat-bg .dis-h"); await pause(p); await p.click('.chat-bg .chat-mini:has-text("Вывод")'); await pause(p, 350); }],
  ["queued", "refactor@win", async (p) => { await type(p, "И обнови README по итогам"); await p.click(".chat-send"); await pause(p, 350); }],
  ["perm", "tests@wsl", async (p) => ask(p, PERM)],
  ["perm-screen", "tests@wsl", async (p) => { await ask(p, PERM); await toScreen(p); }],
  ["perm-deny", "tests@wsl", async (p) => { await ask(p, PERM); await toScreen(p); await p.click('.ask .ask-decline:has-text("Отклонить")'); await pause(p); await p.fill(".ask textarea", "Сначала покажи, что выложится"); await pause(p); }],
  ["perm-done", "tests@wsl", async (p) => { await ask(p, PERM); await toScreen(p); await p.click('.ask .sb-cta'); await pause(p, 350); }],
  ["plan", "tests@wsl", async (p) => ask(p, PLAN)],
  ["plan-screen", "tests@wsl", async (p) => { await ask(p, PLAN); await toScreen(p); }],
  ["plan-return", "tests@wsl", async (p) => { await ask(p, PLAN); await toScreen(p); await p.click('.ask .ask-decline:has-text("Вернуть")'); await pause(p); await p.fill(".ask textarea", "Добавь регрессионный тест"); await pause(p); }],
  ["mode", "tests@wsl", async (p) => { await p.selectOption(".chat-mode", "plan"); await pause(p, 350); }],
  ["scrolled-up", "tests@wsl", async (p) => { await p.evaluate(() => { const f = document.querySelector(".chat-feed"); f.scrollTop = 0; f.dispatchEvent(new Event("scroll")); }); await pause(p); }],
];
const WIDE_ONLY = [
  ["context", "tests@wsl", async (p) => { await p.click('.chat-bar .chat-mini:has-text("контекст")'); await pause(p, 350); }],
  ["rules", "tests@wsl", async (p) => { await p.click('.chat-bar .chat-mini:has-text("контекст")'); await pause(p, 350); await p.evaluate(() => document.querySelector('[data-sec="rules"]').scrollIntoView()); await pause(p); }],
  ["focus", "tests@wsl", async (p) => { await p.click('.chat-bar .chat-mini:has-text("фокус")'); await pause(p); }],
  ["focus-steps", "tests@wsl", async (p) => { await p.click('.chat-bar .chat-mini:has-text("фокус")'); await pause(p); await p.click(".chat-steps .dis-h"); await pause(p); }],
  ["mcp", "tests@wsl", async (p) => { await p.evaluate(() => (location.hash = "#card?callsign=tests%40wsl")); await pause(p, 400); await p.click('[data-pop="menu"]'); await pause(p); await p.click('.cw-pop [data-act="info"]'); await pause(p, 400); await p.click('[data-mcp-login="linear"]'); await pause(p, 300); }],
  ["rewind", "tests@wsl", async (p) => { await p.click(".chat-rw"); await pause(p, 350); }],
];

const b = await launch();
const fails = [];

async function shot(app, viewport, scheme, id, hash, act) {
  if (filter && !id.includes(filter)) return;
  const open = async (p) => {
    await p.goto(url(app, "small", hash));
    await p.waitForSelector(".chat, .chat-gal", { timeout: 5000 });
    await pause(p, 500);
    if (act) await act(p);
    await pause(p, 150);
  };
  // лента у низа остаётся у низа, что бы ни выросло над вводом; уводят от низа только прокрутка вверх и откат к первому сообщению
  const after = async (p) => {
    if (/scrolled-up|rewind/.test(id)) return;
    const gap = await p.evaluate(() => {
      const f = document.querySelector(".chat-feed");
      return f ? f.scrollHeight - f.scrollTop - f.clientHeight : 0;
    });
    if (gap > 4) fails.push(`${id}: лента не у низа, ${Math.round(gap)} точек`);
  };
  await snap(b, { id, app, viewport, scheme, dir: OUT, scope: ".chat *, .chat-gal *", allowed: ".md-table, pre, .chat-diff, .sb-navrow, .cw-tabs", noise: /Content Security Policy|allow-scripts/, open, after }, fails);
}

/** Галерея: разделы отдельными снимками во всю высоту. */
async function gallery(app, width, scheme) {
  const id = `${app}-${scheme}-gallery`;
  if (filter && !id.includes(filter)) return;
  const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errs = errorsOf(p);
  await p.goto(url(app, "small", "#gallery"));
  await p.waitForSelector(".chat-gal", { timeout: 5000 });
  await pause(p, 600);
  const n = await p.locator(".chat-gals").count();
  // раздел слишком высокий для одного кадра: окно во всю высоту ленты
  const h = await p.evaluate(() => document.querySelector(".chat-gal").scrollHeight);
  await p.setViewportSize({ width, height: Math.min(h + 120, 14000) });
  await pause(p, 400);
  for (let i = 0; i < n; i++) await p.locator(".chat-gals").nth(i).screenshot({ path: path.join(OUT, `${id}-${i}.png`) });
  // раскрытое: свёрнутые строки, тела инструментов и просмотр HTML
  await p.evaluate(() => {
    for (const b of document.querySelectorAll('.chat-gal [aria-expanded="false"]')) b.click();
    for (const b of document.querySelectorAll('.chat-gal .cb-b[aria-pressed="false"]')) b.click();
  });
  await pause(p, 700);
  const open = await p.evaluate(() => document.querySelector(".chat-gal").scrollHeight);
  await p.setViewportSize({ width, height: Math.min(open + 120, 16000) });
  await pause(p, 500);
  for (let i = 0; i < n; i++) await p.locator(".chat-gals").nth(i).screenshot({ path: path.join(OUT, `${id}-open-${i}.png`) });
  if (errs.length) fails.push(`${id}: ошибки ${errs.slice(0, 2).join(" | ").slice(0, 240)}`);
  await ctx.close();
}

for (const scheme of ["light", "dark"]) {
  for (const [app, viewport, list] of [
    ["pult", { width: 1280, height: 800 }, [...WINDOWS, ...WIDE_ONLY]],
    ["phone", { width: 390, height: 780 }, WINDOWS],
  ]) {
    for (const [name, cs, act] of list) await shot(app, viewport, scheme, `${app}-${scheme}-${name}`, chat(cs), act);
    await gallery(app, viewport.width, scheme);
  }
}
await b.close();
console.log(fails.length ? fails.join("\n") : `без замечаний · снимки в ${OUT}`);
process.exit(fails.length ? 1 : 0);
