// Живой обход разделов выложенной страницы: node tools/fleet/live-bar.mjs [флот] [устройство] [машина…]
// Называет строки полосы отказов чтения («Не загрузилось: …») на каждом разделе: чтение, которое не проходит на исправном флоте, видно сразу.
// Выход 0 — полоса пуста на всех разделах.
import { fleetEnv } from "../dev.mjs";
import { chromium, fleetCall } from "./harness.mjs";

const [fleet = "test", device = "cli", ...machines] = process.argv.slice(2);
const { call, must } = fleetCall(fleet, device);
const me = must("whoami", {});
const invite = must("invite", { addr: "bar" + Date.now().toString(36).slice(-5) + me.person });
const session = must("fleet.list", {}).sessions?.[0]?.callsign;
const routes = ["/work", ...(session ? ["/work/" + session] : []), "/archive", "/spend", "/fleet", "/fleet/accounts", "/fleet/profiles", "/fleet/releases", "/fleet/incidents", "/observe", "/observe/journal", "/observe/analytics", "/settings", "/settings/alerts", "/settings/people", "/settings/passes", "/settings/proxy", "/new", ...machines.map((m) => "/machine/" + m)];

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];
let lines = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(fleetEnv.SB2_BASE + "/#invite=" + encodeURIComponent(invite.invite));
  await page.locator("nav").first().waitFor({ state: "attached", timeout: 40_000 });
  await page.waitForTimeout(3000);
  for (const r of routes) {
    await page.goto(fleetEnv.SB2_BASE + "/#" + r);
    await page.waitForTimeout(3500);
    const bar = await page.locator(".banner.bad").allInnerTexts();
    lines += bar.length;
    console.log(`${bar.length ? "✗" : "✓"} ${r} · строк полосы ${bar.length}${bar.length ? " · " + bar.join(" | ").slice(0, 400) : ""}`);
  }
} finally {
  await browser.close();
  call("revoke", { kid: invite.kid });
}
console.log(`разделов ${routes.length}, строк полосы ${lines}, ошибок страницы ${errors.length}${errors.length ? " · " + errors.slice(0, 3).join(" | ").slice(0, 300) : ""}`);
process.exit(lines || errors.length ? 1 : 0);
