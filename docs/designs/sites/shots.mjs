// Панель сайта в настоящем браузере: node docs/designs/sites/shots.mjs
// Поднимает эту страницу дизайна так, как её отдаёт сайт флота (строка панели в HTML, настоящий web/public/_sb/kit.js, настройки перед ним),
// с базой сайта в памяти; жесты — клавишами в трёх раскладках, мышью и пальцем; снимки — 1280 и 390, светлая и тёмная, в папку shots/.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../../tools/fleet/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const shots = path.join(here, "shots");
fs.mkdirSync(shots, { recursive: true });

/** База сайта в памяти: ровно те запросы, которые шлёт панель. */
const base = { comments: [], marks: [], n: 0 };
function sql(q, p) {
  if (q.startsWith("SELECT block, seen FROM sb_marks")) return base.marks;
  if (q.startsWith("SELECT id, block, el, label, quote, text, ticket, reply FROM sb_comments")) return base.comments;
  if (q.startsWith("INSERT INTO sb_comments")) return void base.comments.push({ id: ++base.n, block: p[0], el: p[1], label: p[2], quote: p[3], text: p[4], ticket: null, reply: null }) ?? [];
  if (q.startsWith("DELETE FROM sb_comments")) return void (base.comments = base.comments.filter((c) => c.id !== p[0])) ?? [];
  if (q.startsWith("INSERT INTO sb_marks")) return void (base.marks = [...base.marks.filter((m) => m.block !== p[0]), { block: p[0], seen: p[1] }]) ?? [];
  if (q.startsWith("DELETE FROM sb_marks")) return void (base.marks = base.marks.filter((m) => m.block !== p[0])) ?? [];
  throw new Error("база проверки такого запроса не знает: " + q);
}
const server = http.createServer(async (req, res) => {
  const send = (type, body) => (res.writeHead(200, { "content-type": type }), res.end(body));
  if (req.url === "/") return send("text/html; charset=utf-8", `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0">` + fs.readFileSync(path.join(here, "index.html"), "utf8") + `\n<script src="/_sb/kit.js"></script>\n`);
  if (req.url === "/_sb/kit.js") return send("text/javascript; charset=utf-8", `window.sbSite=${JSON.stringify({ name: "sites", comments: true, marks: true, commit: "a1b2c3d", dirty: false })};\n` + fs.readFileSync(path.join(root, "web/public/_sb/kit.js"), "utf8"));
  let raw = "";
  for await (const d of req) raw += d;
  if (req.url === "/_sb/db") { const q = JSON.parse(raw); return send("application/json", JSON.stringify({ rows: sql(q.sql, q.params ?? []) ?? [] })); }
  if (req.url === "/_sb/submit") { const d = base.comments.filter((c) => !c.ticket); for (const c of d) c.ticket = "design-12"; return send("application/json", JSON.stringify({ ticket: d.length ? "design-12" : null, comments: d.length })); }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launchBrowser();
let done = 0;
const total = 8;
const ok = (what, cond, seen) => { if (!cond) throw new Error(`✗ ${what}: ${JSON.stringify(seen)}`); console.log(`✓ ${what}`); done++; };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.locator("#sb-kit .sb-bar").waitFor();
  const isNew = (id) => page.evaluate((x) => document.getElementById(x).classList.contains("sb-new"), id);
  /** Клавиша по месту на клавиатуре с буквой раскладки: браузер шлёт code и key раздельно. */
  const key = (code, k) => page.evaluate(([c, kk]) => document.dispatchEvent(new KeyboardEvent("keydown", { code: c, key: kk, bubbles: true })), [code, k]);
  const marks = () => base.marks.map((m) => m.block).sort().join(",");

  // «просмотрено»: три раскладки одной клавишей
  await page.locator("#map h2").hover();
  await key("KeyA", "a");
  await page.waitForFunction(() => !document.getElementById("map").classList.contains("sb-new"));
  ok("A, латинская раскладка: блок «Вся система» просмотрен, фон блока обычный", marks() === "map" && (await isNew("address")), marks());
  await page.locator("#address h2").hover();
  await key("KeyA", "ф");
  await page.waitForFunction(() => !document.getElementById("address").classList.contains("sb-new"));
  ok("A, русская раскладка (буква «ф»): блок «Адрес» просмотрен", marks() === "address,map", marks());
  await key("KeyA", "ф");
  await page.waitForFunction(() => document.getElementById("address").classList.contains("sb-new"));
  ok("A ещё раз, украинская раскладка: метка снята, блок снова жёлтый целиком", marks() === "map", marks());

  // комментарий: клавиша, затем мышь по элементу
  await key("KeyC", "c");
  await page.locator("#store h2").hover();
  ok("C, латинская: режим комментария, элемент под курсором обведён", await page.evaluate(() => document.body.classList.contains("sb-c") && document.querySelector("#store h2").classList.contains("sb-hot")), null);
  await page.locator("#store h2").click();
  await page.locator(".sb-pop textarea").fill("Где лежит секрет адреса?");
  await page.keyboard.press("Enter");
  await page.locator(".sb-pin").first().waitFor();
  ok("мышь по элементу: комментарий привязан к заголовку блока «Где что лежит»", base.comments[0]?.block === "store" && base.comments[0]?.label === "Где что лежит", base.comments[0]);
  await key("KeyC", "с");
  await page.locator("#db h2").click();
  await page.locator(".sb-pop textarea").fill("Таблицы панели видны странице?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".sb-pin").length === 2);
  ok("C, русская раскладка (буква «с»): второй комментарий, «Отправить · 2»", (await page.locator(".sb-go").textContent()) === "Отправить · 2", await page.locator(".sb-go").textContent());
  await page.screenshot({ path: path.join(shots, "panel-1280-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: path.join(shots, "panel-1280-dark.png") });
  await ctx.close();

  // телефон: те же действия пальцем — кнопками панели
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "light" });
  const p = await phone.newPage();
  await p.goto(url);
  await p.locator("#sb-kit .sb-bar").waitFor();
  await p.locator(".sb-bar button", { hasText: "✓" }).tap();
  await p.locator("#panel h2").tap();
  await p.waitForFunction(() => !document.getElementById("panel").classList.contains("sb-new"));
  ok("палец: «✓» и блок — блок «Панель» просмотрен", marks() === "map,panel", marks());
  await p.locator(".sb-go").tap();
  await p.waitForFunction(() => document.querySelectorAll(".sb-pin.sb-sent").length === 2);
  ok("палец: «Отправить» — оба комментария ушли одним тикетом, метки серые", base.comments.every((c) => c.ticket === "design-12") && (await p.locator(".sb-go").isHidden()), base.comments);
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (wide > 0) throw new Error(`✗ страница на телефоне шире экрана на ${wide}px`);
  await p.locator("#store").scrollIntoViewIfNeeded();
  await p.screenshot({ path: path.join(shots, "panel-390-light.png") });
  await p.emulateMedia({ colorScheme: "dark" });
  await p.screenshot({ path: path.join(shots, "panel-390-dark.png") });
  await phone.close();
  console.log(`жестов ${done} из ${total} · снимков 4 · ${shots}`);
} finally {
  await browser.close();
  server.close();
}
