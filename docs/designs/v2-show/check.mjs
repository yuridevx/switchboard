// Проверка страницы дизайна перед публикацией: скрипты исполняются в jsdom без ошибок, id не повторяются, у каждого блока и стрелки схемы есть пояснение.
// node docs/designs/v2-show/check.mjs [--look] — с --look ещё и снимки страницы в Chrome (1280 и 390, светлая и тёмная).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const need = createRequire(path.join(root, "web/package.json"));
const html = fs.readFileSync(path.join(here, "index.html"), "utf8");
const { JSDOM } = need("jsdom");
const errors = [];
const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { runScripts: "dangerously", url: "https://example.com/", pretendToBeVisual: true, virtualConsole: new (need("jsdom").VirtualConsole)().on("jsdomError", (e) => errors.push(String(e))) });
const doc = dom.window.document;
const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id);
const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
const chg = [...doc.querySelectorAll("[data-chg]")].map((e) => e.dataset.chg);
const chgTwice = chg.filter((c, i) => chg.indexOf(c) !== i);
// каждое пояснение открывается нажатием и непусто — у узлов и у стрелок каждого потока
let silent = 0, marks = 0;
const click = (n) => n.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
const tabs = [...doc.querySelectorAll("#flows button")];
for (const tab of tabs.length ? tabs : [null]) {
  if (tab) click(tab);
  for (const n of doc.querySelectorAll("#dia [data-i]")) {
    click(n);
    marks++;
    if (doc.getElementById("say").textContent.length < 20) silent++;
  }
}
// метка «прочитал» ставится клавишей над блоком
const block = doc.querySelector("[data-block]");
block.dispatchEvent(new dom.window.Event("mouseenter"));
doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ф", code: "KeyA" }));
const marked = block.classList.contains("read");
const scripts = doc.querySelectorAll("script");
const lastIsMarks = /метки «прочитал»/.test(scripts[scripts.length - 1].textContent);
console.log(`ошибок скриптов ${errors.length} · повторов id ${twice.length} · повторов data-chg ${chgTwice.length} · потоков ${tabs.length}, узлов и стрелок по всем потокам ${marks}, без пояснения ${silent} · полос ${doc.querySelectorAll("#bars .pair").length} · эталонов ${doc.querySelectorAll("#ets .et").length} · метка ставится: ${marked} · скрипт меток последний: ${lastIsMarks}`);
let bad = errors.length || twice.length || chgTwice.length || silent || !marked || !lastIsMarks;
if (process.argv.includes("--look")) {
  const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const tmp = path.join(here, ".look.html");
  fs.writeFileSync(tmp, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:14px system-ui}img{max-width:100%}</style></head><body>${html}</body></html>`);
  for (const [w, scheme] of [[1280, "light"], [1280, "dark"], [390, "light"]]) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 }, colorScheme: scheme });
    await page.goto(pathToFileURL(tmp).href);
    await page.waitForTimeout(1200);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) { bad = true; console.log(`ширина ${w}: страница шире экрана на ${over}px`); }
    await page.screenshot({ path: path.join(here, `.look-${w}-${scheme}.png`), fullPage: true });
    await page.close();
  }
  await browser.close();
  fs.rmSync(tmp);
}
process.exit(bad ? 1 : 0);
