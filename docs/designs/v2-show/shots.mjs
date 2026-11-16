// Снимки прототипа «Файлы сессии»: node docs/designs/v2-show/shots.mjs [адрес=http://localhost:4836]
// Проходит сценарии в настоящем Chrome на моке: файлы человека в его сообщении, файлы, отправленные сессией (показ и скачивание),
// сайт сессии в рамке и целым листом, схема из блока текста, загрузка любого файла из поля ввода, отказ на месте файла.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");
const base = process.argv[2] ?? "http://localhost:4836";
const out = path.join(here, "shots");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
let bad = 0;
for (const [w, h] of [[1280, 860], [390, 844]]) for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: w < 500, acceptDownloads: true });
  page.setDefaultTimeout(9000);
  await page.addInitScript((t) => localStorage.setItem("mantine-color-scheme-value", t), theme);
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}-${w}-${theme}.png`) });
  const open = async (hash) => { await page.goto(`${base}/?mock&still#${hash}`); await page.waitForTimeout(900); };
  const step = async (label, fn) => { try { await fn(); console.log(`✓ ${w} ${theme} · ${label}`); } catch (e) { bad++; await page.screenshot({ path: path.join(out, `fail-${w}-${theme}.png`) }); console.log(`✗ ${w} ${theme} · ${label} · ${String(e.message).split("\n")[0]}`); } };
  const tap = (loc) => (w < 500 ? loc.tap() : loc.click());
  // вырезка одного элемента — для страницы дизайна
  const crop = (name, loc) => loc.screenshot({ path: path.join(out, `crop-${name}-${w}-${theme}.png`) });
  const sent = (p) => page.locator(`.fileshow[data-file="${p}"]`);
  const back = async () => { await tap(page.getByRole("button", { name: "Назад" })); await page.locator('[data-step="file"]').waitFor({ state: "detached" }); };

  await step("файлы человека стоят в его сообщении: картинка превью, документ строкой со «скачать»", async () => {
    await open("/work/docs@laptop");
    const pic = page.locator('.me-pic[data-file="maket.png"] img');
    await pic.waitFor();
    await pic.scrollIntoViewIfNeeded();
    const doc = page.locator('.me-file[data-file="spec.pdf"]');
    if (!/2,3 МБ/.test(await doc.innerText())) throw new Error("нет размера документа");
    await doc.getByRole("button", { name: "Скачать spec.pdf" }).waitFor();
    await shot("uploaded");
    await crop("uploaded", page.locator(".me", { has: pic }));
  });
  await step("отправленный график стоит в ленте картинкой с подписью и размером", async () => {
    const card = sent("out/latency.svg");
    await card.locator("img").waitFor();
    await card.scrollIntoViewIfNeeded();
    if (!(await card.locator("img").evaluate((i) => i.complete && i.naturalWidth > 100))) throw new Error("график пустой");
    if (!/Время ответа за сутки/.test(await card.innerText()) || !/5 КБ/.test(await card.innerText())) throw new Error("нет подписи или размера");
    await shot("chart");
    await crop("chart", card);
  });
  await step("вызовы отправки и сайта — не строки инструментов", async () => {
    if (await page.locator(".toolrow", { hasText: /Отправка файла|Сайт/ }).count()) throw new Error("вызов стоит строкой инструмента");
  });
  await step("архив — строкой без показа; «скачать» отдаёт файл браузеру под своим именем", async () => {
    const card = sent("dist/report.zip");
    await card.scrollIntoViewIfNeeded();
    if (await card.locator("img, iframe, pre").count()) throw new Error("у архива есть показ");
    const got = page.waitForEvent("download");
    await tap(card.getByRole("button", { name: "Скачать report.zip" }));
    if ((await got).suggestedFilename() !== "report.zip") throw new Error("имя скачанного не то");
    await crop("zip", card);
  });
  await step("сайт сессии — в рамке-песочнице, адрес открывается в новой вкладке", async () => {
    const card = page.locator('.fileshow[data-site="out/site"]');
    const frame = card.locator("iframe.htmlframe");
    await frame.waitFor();
    await card.scrollIntoViewIfNeeded();
    if (!/^allow-scripts/.test((await frame.getAttribute("sandbox")) ?? "")) throw new Error("рамка не в песочнице");
    if (!/\/s\/[0-9a-f]{32}\//.test((await frame.getAttribute("src")) ?? "")) throw new Error("у рамки не адрес сайта");
    await page.frameLocator('.fileshow[data-site="out/site"] iframe.htmlframe').locator("h1").waitFor();
    if ((await card.locator("a").getAttribute("target")) !== "_blank") throw new Error("адрес не в новой вкладке");
    await shot("site");
    await crop("site", card);
  });
  await step("сайт открывается целым листом и закрывается «Назад»", async () => {
    await tap(page.locator('.fileshow[data-site="out/site"]').getByRole("button", { name: /Открыть целиком/ }));
    await page.frameLocator('[data-step="file"] iframe.htmlframe').locator("h1").waitFor();
    await page.waitForTimeout(300);
    await shot("site-whole");
    await back();
  });
  await step("отправленный снимок — картинкой, по нажатию целым листом", async () => {
    const card = sent("shots/header-390.png");
    await card.locator("img").waitFor();
    await card.scrollIntoViewIfNeeded();
    await shot("picture");
    await crop("picture", card);
    await tap(card.getByRole("button", { name: /Открыть целиком/ }));
    await page.locator('[data-step="file"] img.filepic').waitFor();
    await back();
  });
  await step("схема mermaid нарисована из блока текста и открывается целым листом", async () => {
    const scheme = page.locator(".codeblock img.svgview").first();
    await scheme.waitFor({ timeout: 20_000 });
    await scheme.scrollIntoViewIfNeeded();
    if (!(await scheme.evaluate((i) => i.naturalWidth > 100))) throw new Error("схема пустая");
    await shot("scheme");
    await crop("scheme", page.locator(".codeblock:has(img.svgview)").first());
    await tap(page.getByRole("button", { name: "Открыть схему целиком" }).first());
    await page.locator('[data-step="file"] img.svgview').waitFor();
    await back();
  });
  await step("человек загружает файл любого вида: он уходит в хранилище, в сообщении — имя и размер, скачивается обратно", async () => {
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(3072)], "dump.bin", { type: "application/octet-stream" }));
      document.querySelector(".feed").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    const box = page.getByLabel("Сообщение сессии");
    await box.fill("Вот дамп, разбери его.");
    await box.press("Enter");
    const mine = page.locator('.me-file[data-file="dump.bin"]');
    await mine.waitFor();
    if (!/3 КБ/.test(await mine.innerText())) throw new Error("нет размера загруженного");
    const got = page.waitForEvent("download");
    await tap(mine.getByRole("button", { name: "Скачать dump.bin" }));
    if ((await got).suggestedFilename() !== "dump.bin") throw new Error("загруженное не скачалось под своим именем");
    await mine.scrollIntoViewIfNeeded();
    await shot("upload");
  });
  await step("содержимого в хранилище нет — слово отказа на месте файла", async () => {
    await open("/work/nightcheck@server");
    const card = sent("out/builds.png");
    await card.locator(".filefail").waitFor();
    if (!/Такого файла нет/.test(await card.innerText())) throw new Error("нет слова отказа");
    await card.scrollIntoViewIfNeeded();
    await crop("nofile", card);
  });
  await page.close();
}
await browser.close();
console.log(bad ? `сбоев: ${bad}` : "все шаги прошли");
process.exit(bad ? 1 : 0);
