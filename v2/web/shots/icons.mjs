// Значки приложения из public/icon.svg: 192, 512 и значок для iPhone 180. node shots/icons.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const svg = fs.readFileSync(path.join(pub, "icon.svg"), "utf8");
const browser = await chromium.launch({ channel: "chrome" });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: path.join(pub, name), omitBackground: true });
  await page.close();
}
await browser.close();
console.log("значки собраны");
