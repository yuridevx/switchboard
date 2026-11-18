// Живой обход разделов выложенной страницы: node tools/fleet/live-bar.mjs [флот] [устройство] [машина…]
// Называет строки полосы отказов чтения («Не загрузилось: …») на каждом разделе: чтение, которое не проходит на исправном флоте, видно сразу.
// Выход 0 — полоса пуста на всех разделах.
import { fleetEnv } from "../dev.mjs";
import { fleetCall, lacks, launchBrowser, newTag } from "./harness.mjs";

const [fleet = "test", device = "cli", ...machines] = process.argv.slice(2);
const { call, must } = fleetCall(fleet, device);
const me = must("whoami", {});
const invite = must("invite", { addr: "bar" + newTag() + me.person });
const session = must("fleet.list", {}).sessions?.[0]?.callsign;
// «Расход» и «Аккаунты» (с них открывается «Флот») читают историю флота — она в ClickHouse
const history = lacks("clickhouse") ? [] : ["/spend", "/fleet", "/fleet/accounts"];
const routes = ["/work", ...(session ? ["/work/" + session] : []), "/archive", ...history, "/fleet/profiles", "/fleet/releases", "/fleet/incidents", "/observe", "/observe/journal", "/observe/analytics", "/settings", "/settings/alerts", "/settings/people", "/settings/passes", "/settings/proxy", "/new", ...machines.map((m) => "/machine/" + m)];

const browser = await launchBrowser();
const errors = [];
let lines = 0;
try {
  // вход один на все вкладки: приглашение принимает первая, разделы открываются разом каждый в своей
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const first = await ctx.newPage();
  first.on("pageerror", (e) => errors.push(e.message));
  await first.goto(fleetEnv.SB2_BASE + "/#invite=" + encodeURIComponent(invite.invite));
  await first.locator("nav").first().waitFor({ state: "attached", timeout: 40_000 });
  await first.waitForTimeout(3000);
  // разделы открываются по шесть вкладок: всем сразу на одном компьютере тесно — вкладка не успевала загрузиться за предел перехода
  const seen = [];
  for (let i = 0; i < routes.length; i += 6) seen.push(...await Promise.all(routes.slice(i, i + 6).map(async (r) => {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(fleetEnv.SB2_BASE + "/#" + r);
    await page.waitForTimeout(3500);
    const bar = await page.locator(".banner.bad").allInnerTexts();
    await page.close();
    return { r, bar };
  })));
  for (const { r, bar } of seen) {
    lines += bar.length;
    console.log(`${bar.length ? "✗" : "✓"} ${r} · строк полосы ${bar.length}${bar.length ? " · " + bar.join(" | ").slice(0, 400) : ""}`);
  }
} finally {
  await browser.close();
  call("revoke", { kid: invite.kid });
}
console.log(`разделов ${routes.length}, строк полосы ${lines}, ошибок страницы ${errors.length}${errors.length ? " · " + errors.slice(0, 3).join(" | ").slice(0, 300) : ""}`);
process.exit(lines || errors.length ? 1 : 0);
