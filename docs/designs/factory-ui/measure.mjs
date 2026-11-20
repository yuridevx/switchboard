// Замер цеха «Фабрики» на моке флота: node docs/designs/factory-ui/measure.mjs [адрес=http://localhost:4861]
// Три числа на фабрику и ширину окна: высота экрана; где стоит первый тикет, который ждёт человека (от верха экрана);
// сколько на экране пустых коробок — рамок и заливок, внутри которых нет ни тикета, ни поста, ни входа, ни кнопки.
// Числа считаются по тому, что нарисовано, а не по именам классов: один и тот же замер идёт и старому экрану, и новому.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { chromium } = createRequire(path.join(root, "web", "package.json"))("playwright-core");
const base = process.argv[2] ?? "http://localhost:4861";
/** фабрика мока и её тикеты, которые ждут человека: шаг человека и стоп */
const FLOORS = [["infra", ["infra-41", "infra-39"]], ["research", []]];

const browser = await chromium.launch();
const rows = [];
for (const [w, h] of [[1280, 900], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: "ru-RU" });
  for (const [project, human] of FLOORS) {
    const page = await ctx.newPage();
    await page.goto(`${base}/?still#/factory/${project}`);
    await page.locator(".flane").first().waitFor();
    rows.push({ project, width: w, ...(await page.evaluate((human) => {
      const scroll = document.querySelector(".scroll");
      const top = scroll.getBoundingClientRect().top;
      const y = (el) => Math.round(el.getBoundingClientRect().top - top + scroll.scrollTop);
      const first = human.flatMap((id) => [...document.querySelectorAll(`[data-ticket="${id}"]`)]).map(y).sort((a, b) => a - b)[0];
      const boxed = (el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        const filled = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== getComputedStyle(document.body).backgroundColor;
        const framed = parseFloat(s.borderTopWidth) > 0 && parseFloat(s.borderLeftWidth) > 0 && s.borderLeftStyle !== "none";
        return (filled || framed) && r.width >= 100 && r.height >= 40;
      };
      const holds = (el) => el.matches("[data-ticket], [data-post], [data-on]") || !!el.querySelector("[data-ticket], [data-post], [data-on], button, input");
      const empty = [...document.querySelectorAll(".page.factory *")].filter((el) => boxed(el) && !holds(el) && !el.closest("[data-ticket], [data-post], [data-on], button"));
      // коробка в коробке считается один раз — внешняя
      const outer = empty.filter((el) => !empty.some((o) => o !== el && o.contains(el)));
      // высота содержимого, а не окна: экран короче окна тоже меряется своим числом
      return { height: document.querySelector(".page.factory").offsetHeight, ...(first === undefined ? {} : { humanAt: first }), emptyBoxes: outer.length };
    }, human)) });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
// свойства экрана: тикет, который ждёт человека, виден без прокрутки; пустых коробок нет
const VIEW = { 1280: 900, 390: 844 };
const bad = rows.filter((r) => r.emptyBoxes > 0 || (r.humanAt !== undefined && r.humanAt >= VIEW[r.width]));
for (const r of rows) console.log(`${r.project.padEnd(9)} ${String(r.width).padStart(4)}  высота ${String(r.height).padStart(4)}  ждёт человека на ${r.humanAt === undefined ? "  —" : String(r.humanAt).padStart(4)}  пустых коробок ${r.emptyBoxes}`);
console.log(bad.length ? `не сходится: ${bad.map((r) => `${r.project} ${r.width}`).join(", ")}` : `замеров ${rows.length}, все сходятся`);
process.exit(bad.length ? 1 : 0);
