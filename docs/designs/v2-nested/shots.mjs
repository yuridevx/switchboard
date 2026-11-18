// Снимки «Вложенные сессии сворачиваются»: node docs/designs/v2-nested/shots.mjs [папка=shots] [адрес=http://localhost:4851]
// Настоящий список «Работы» на моке в Chrome: шеврон у родителя, свёрнутый родитель светит лампами дочерних, выбор помнит устройство,
// открытая спрятанная сессия подсвечивает строку родителя, j/k идут по видимым строкам. На 1280 жесты — мышью, на 390 — пальцем.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const { chromium } = createRequire(path.join(root, "web", "package.json"))("playwright-core");
const out = path.join(here, process.argv[2] ?? "shots");
const base = process.argv[3] ?? "http://localhost:4851";
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
let bad = 0, total = 0;
for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
  const wide = w > 860;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: !wide });
  page.setDefaultTimeout(9000);
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const list = page.locator(".pane.list");
  /** Снимок списка целиком и отдельно — группы «Сайт», где стоит дерево. */
  const shot = async (name) => {
    if (wide) await page.mouse.move(900, 500);
    await (wide ? list : page).screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`) });
    await list.locator('[data-drop-group="site"]').screenshot({ path: path.join(out, `grp-${name}-${w}-${theme}.png`) });
  };
  const press = (loc) => (wide ? loc.click() : loc.tap());
  const step = async (label, fn) => {
    total++;
    try { await fn(); console.log(`✓ ${w} ${theme} · ${label}`); }
    catch (e) { bad++; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); }
  };
  const open = async (hash) => { await page.goto(`${base}/?mock&still#${hash}`); await page.reload(); await list.locator(".row").first().waitFor(); await page.waitForTimeout(400); };
  const calls = () => list.locator(".row").evaluateAll((els) => els.map((e) => e.dataset.call));
  const row = (c) => list.locator(`.row[data-call="${c}"]`);
  const fold = (c) => list.getByRole("button", { name: new RegExp(`дочерние: ${c}$`) });
  const KIDS = ["header-css@laptop", "header-shots@laptop", "shots-diff@laptop"];
  const start = wide ? "/work/docs@laptop" : "/work";

  await step("шеврон — только у родителей; дочерние стоят под родителем с отступом", async () => {
    await open(start);
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("sb2.ui.work.")).forEach((k) => localStorage.removeItem(k)));
    await open(start);
    const all = await calls();
    const at = all.indexOf("site@laptop");
    if (all.slice(at + 1, at + 4).sort().join() !== KIDS.join()) throw new Error("под site@laptop: " + all.slice(at + 1, at + 4).join());
    const withBtn = await list.locator(".kidsbtn").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label").split(": ")[1]));
    if (withBtn.sort().join() !== ["header-shots@laptop", "ingest@server", "site@laptop"].join()) throw new Error("шевроны у: " + withBtn.join());
    if (await fold("site@laptop").getAttribute("aria-expanded") !== "true") throw new Error("родитель не раскрыт с самого начала");
    // шеврон не сдвигает строку: лампы родителя и соседа без дочерних стоят на одной вертикали
    const x = async (c) => Math.round((await row(c).locator(".lamp").first().boundingBox()).x);
    if (await x("site@laptop") !== await x("docs@laptop")) throw new Error(`лампа родителя сдвинута: ${await x("site@laptop")} и ${await x("docs@laptop")}`);
    // шеврон не наезжает на лампу; цель нажатия — во всю высоту строки
    const b = await fold("site@laptop").boundingBox(), r = await row("site@laptop").boundingBox(), lamp = await row("site@laptop").locator(".lamp").first().boundingBox();
    const glyph = await fold("site@laptop").locator("svg").boundingBox();
    if (glyph.x + glyph.width > lamp.x) throw new Error(`шеврон наезжает на лампу: ${Math.round(glyph.x + glyph.width)} > ${Math.round(lamp.x)}`);
    if (Math.abs(b.height - r.height) > 1) throw new Error("цель шеврона не во всю строку: " + Math.round(b.height));
    if (!wide && b.width < 28) throw new Error("цель шеврона на телефоне уже 28 px: " + Math.round(b.width));
    await shot("open");
  });
  await step("нажатие на шеврон прячет всех потомков и сессию не открывает; свёрнутый родитель светит лампами тех, кто работает и ждёт", async () => {
    const before = await calls(), addr = page.url();
    await press(fold("site@laptop"));
    const after = await calls();
    if (before.length - after.length !== 3 || KIDS.some((k) => after.includes(k))) throw new Error(`строк ${before.length} → ${after.length}`);
    if (page.url() !== addr) throw new Error("нажатие на шеврон открыло сессию: " + page.url());
    if (await fold("site@laptop").getAttribute("aria-expanded") !== "false") throw new Error("шеврон не показывает свёрнутое");
    const lamps = await row("site@laptop").locator(".when .lamps .lamp").evaluateAll((els) => els.map((e) => e.className.replace("lamp ", "")));
    if (lamps.sort().join() !== "busy,waiting") throw new Error("лампы свёрнутого: " + lamps.join());
    await shot("folded");
  });
  await step("свёрнутое помнит устройство: после перезагрузки родитель свёрнут", async () => {
    await page.reload();
    await row("site@laptop").waitFor();
    if ((await calls()).some((c) => KIDS.includes(c))) throw new Error("после перезагрузки дочерние видны");
    if (await fold("site@laptop").getAttribute("aria-expanded") !== "false") throw new Error("после перезагрузки родитель раскрыт");
  });
  if (wide) await step("открытая спрятанная сессия подсвечивает строку свёрнутого родителя; родитель остаётся свёрнутым", async () => {
    await open("/work/header-shots@laptop");
    await page.locator(".pane.detail").getByText("header-shots@laptop").first().waitFor();
    if (!/\bsel\b/.test(await row("site@laptop").getAttribute("class"))) throw new Error("строка родителя не подсвечена");
    if ((await calls()).includes("header-shots@laptop")) throw new Error("родитель раскрылся сам");
    await shot("held");
  });
  if (wide) await step("j и k идут по видимым строкам: из спрятанной сессии — к соседу родителя", async () => {
    const all = await calls();
    const next = all[all.indexOf("site@laptop") + 1];
    await page.locator(".pane.list h1").click();
    await page.keyboard.press("j");
    const hash = async (want) => { await page.waitForTimeout(500); const got = decodeURIComponent(await page.evaluate(() => location.hash)); if (got !== `#/work/${want}`) throw new Error(`ждали ${want}, открыто ${got}`); };
    await hash(next);
    await page.keyboard.press("k");
    await hash("site@laptop");
  });
  await step("раскрытие возвращает строки; сворачивается и середина дерева — тихий потомок ламп не даёт", async () => {
    await open(start);
    await press(fold("site@laptop"));
    const back = await calls();
    if (!KIDS.every((k) => back.includes(k))) throw new Error("строки не вернулись");
    const n = back.length;
    await press(fold("header-shots@laptop"));
    const after = await calls();
    if (n - after.length !== 1 || after.includes("shots-diff@laptop")) throw new Error(`середина: ${n} → ${after.length}`);
    if (await row("header-shots@laptop").locator(".when .lamps").count()) throw new Error("у родителя со свободным потомком загорелись лампы");
    await shot("middle");
    await press(fold("header-shots@laptop"));
    if (!(await calls()).includes("shots-diff@laptop")) throw new Error("середина не раскрылась");
  });
  await step("«Дочерние под родителем» выключено — дерева нет, шевронов нет", async () => {
    await press(list.getByRole("button", { name: "Вид списка" }));
    await press(page.getByRole("switch", { name: "Дочерние под родителем" }));
    await page.keyboard.press("Escape");
    if (await list.locator(".kidsbtn").count()) throw new Error("шевроны остались без дерева");
    await press(list.getByRole("button", { name: "Вид списка" }));
    await press(page.getByRole("switch", { name: "Дочерние под родителем" }));
    await page.keyboard.press("Escape");
    await fold("site@laptop").waitFor();
  });
  await page.close();
}
await browser.close();
console.log(bad ? `сбоев: ${bad} из ${total}` : `снимки сняты: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
