// Снимки чата настоящего кода: галерея всех карточек по разделам и все окна живого экрана — пульт и телефон, светлая и тёмная.
// node scripts/shots/chat.mjs [часть имени снимка]; снимки смотрит глазами тот, кто запустил; замечания — выход за край и ошибки страницы.
import { mkdirSync } from "node:fs";
import path from "node:path";
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
  ["suggestion", "tests@wsl", async (p) => { await p.evaluate(() => window.__relay.push({ type: "session.events", from: "tests@wsl", seq: 900, events: [{ type: "prompt_suggestion", suggestion: "Закоммить правку и выложи на тестовый флот" }] })); await pause(p); }],
  ["streaming", "refactor@win", async (p) => { await p.evaluate(() => window.__relay.push({ type: "session.events", from: "refactor@win", seq: 901, events: [{ type: "stream_event", event: { type: "message_start", message: { id: "m-live" } } }, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Пишу итог: **сборка зелёная**, осталось обновить" } } }] })); await pause(p); }],
  ["todo-open", "refactor@win", async (p) => { await p.click(".chat-todo .dis-h"); await pause(p); }],
  ["background-open", "refactor@win", async (p) => { await p.click(".chat-bg .dis-h"); await pause(p); }],
  ["side-wait", "tests@wsl", async (p) => { await type(p, "/btw это долго?"); await p.click(".chat-send"); await pause(p); }],
  ["side-answer", "tests@wsl", async (p) => { await type(p, "/btw какая версия?"); await p.click(".chat-send"); await pause(p); }],
  ["side-refused", "tests@wsl", async (p) => { await type(p, "/btw нельзя?"); await p.click(".chat-send"); await pause(p); }],
  ["btw-hint", "tests@wsl", async (p) => type(p, "/b")],
  ["task-output", "refactor@win", async (p) => { await p.click(".chat-bg .dis-h"); await pause(p); await p.click('.chat-bg .chat-mini:has-text("Вывод")'); await pause(p, 350); }],
  ["queued", "refactor@win", async (p) => { await type(p, "И обнови README по итогам"); await p.click(".chat-send"); await pause(p, 350); }],
  ["scrolled-up", "tests@wsl", async (p) => { await p.evaluate(() => { const f = document.querySelector(".chat-feed"); f.scrollTop = 0; f.dispatchEvent(new Event("scroll")); }); await pause(p); }],
];
const WIDE_ONLY = [
  ["context", "tests@wsl", async (p) => { await p.click('.chat-bar .chat-mini:has-text("контекст")'); await pause(p, 350); }],
  ["focus", "tests@wsl", async (p) => { await p.click('.chat-bar .chat-mini:has-text("фокус")'); await pause(p); }],
  ["focus-steps", "tests@wsl", async (p) => { await p.click('.chat-bar .chat-mini:has-text("фокус")'); await pause(p); await p.click(".chat-steps .dis-h"); await pause(p); }],
  ["mcp", "tests@wsl", async (p) => { await p.evaluate(() => (location.hash = "#card?callsign=tests%40wsl")); await pause(p, 400); await p.click('[data-pop="menu"]'); await pause(p); await p.click('.cw-pop [data-act="info"]'); await pause(p, 400); await p.click('[data-mcp-login="linear"]'); await pause(p, 300); }],
  ["rewind", "tests@wsl", async (p) => { await p.click(".chat-rw"); await pause(p, 350); }],
];

const b = await launch();
const fails = [];

async function shot(app, viewport, scheme, id, hash, act) {
  if (filter && !id.includes(filter)) return;
  const ctx = await b.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: app === "phone" ? 2 : 1, hasTouch: app === "phone", isMobile: app === "phone" });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && !/Content Security Policy|allow-scripts/.test(m.text()) && errs.push(m.text()));
  try {
    await p.goto(url(app, "small", hash));
    await p.waitForSelector(".chat, .chat-gal", { timeout: 5000 });
    await pause(p, 500);
    if (act) await act(p);
    await pause(p, 150);
    await p.screenshot({ path: path.join(OUT, `${id}.png`) });
    // лента у низа остаётся у низа, что бы ни выросло над вводом; уводят от низа только прокрутка вверх и откат к первому сообщению
    if (!/scrolled-up|rewind/.test(id)) {
      const gap = await p.evaluate(() => {
        const f = document.querySelector(".chat-feed");
        return f ? f.scrollHeight - f.scrollTop - f.clientHeight : 0;
      });
      if (gap > 4) fails.push(`${id}: лента не у низа, ${Math.round(gap)} точек`);
    }
    const over = await p.evaluate(() => {
      const de = document.documentElement;
      const bad = [...document.querySelectorAll(".chat *, .chat-gal *")]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > innerWidth + 1 && !e.closest(".md-table, pre, .chat-diff, .sb-navrow, .cw-tabs");
        })
        .slice(0, 4)
        .map((e) => e.className || e.tagName);
      return { x: de.scrollWidth - de.clientWidth, bad };
    });
    if (over.x > 0 || over.bad.length) fails.push(`${id}: выход за край ${over.x}px ${over.bad.join(" | ")}`);
  } catch (e) {
    fails.push(`${id}: ${e.message.split("\n")[0]}`);
  }
  if (errs.length) fails.push(`${id}: ошибки ${errs.slice(0, 2).join(" | ").slice(0, 240)}`);
  await ctx.close();
}

/** Галерея: разделы отдельными снимками во всю высоту. */
async function gallery(app, width, scheme) {
  const id = `${app}-${scheme}-gallery`;
  if (filter && !id.includes(filter)) return;
  const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
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
