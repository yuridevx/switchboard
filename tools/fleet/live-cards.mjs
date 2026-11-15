// Живая проверка карточек входящего на выложенной странице: node tools/fleet/live-cards.mjs <флот> <устройство> <позывной сессии> [папка снимков]
// Принимает приглашение в настоящем Chrome, открывает разговор сессии и называет карточки входящего от флота, которые в нём стоят.
// Сессию с входящими оставляет живая проверка связи: KEEP=1 node tools/fleet/live-comms.ts … — её ведущая получает итоги дочери.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fleetEnv } from "../dev.mjs";
import { chromium, fleetCall } from "./harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [fleet = "test", device = "cli", callsign, outArg] = process.argv.slice(2);
if (!callsign) throw new Error("нужен позывной сессии с входящими от флота");
const out = outArg ?? path.join(root, "dist", "live");
fs.mkdirSync(out, { recursive: true });
const { call } = fleetCall(fleet, device);
const me = call("whoami", {}).result;
const invite = call("invite", { addr: "cards" + Date.now().toString(36).slice(-5) + me.person }).result;

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];
let cards = [];
try {
  // приглашение одноразовое: вход один, размер и тема меняются в той же странице
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(fleetEnv.SB2_BASE + "/#invite=" + encodeURIComponent(invite.invite));
  // приглашение принято и картина пришла, когда в «Работе» видна сама сессия: до этого переход к ней теряется
  for (let i = 0; i < 40 && !(await page.locator("body").innerText()).includes(callsign); i++) await page.waitForTimeout(1000);
  await page.goto(fleetEnv.SB2_BASE + "/#/work/" + callsign);
  await page.locator(".pcard").first().waitFor({ state: "attached", timeout: 30_000 });
  for (const [w, h, scheme] of [[1280, 900, "light"], [390, 844, "dark"]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(800);
    cards = await page.locator(".pcard").evaluateAll((els) => els.map((e) => `${e.getAttribute("aria-label")} [${e.className.replace("pcard ", "")}]`));
    await page.locator(".pcard").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `cards-${w}-${scheme}.png`) });
  }
} finally {
  await browser.close();
  call("revoke", { kid: invite.kid });
}
console.log(`карточек входящего: ${cards.length}`);
for (const c of [...new Set(cards)]) console.log("  " + c);
console.log("ошибок страницы:", errors.length, errors.slice(0, 5).join(" | ").slice(0, 600));
console.log("снимки:", out);
process.exit(!cards.length || errors.length ? 1 : 0);
