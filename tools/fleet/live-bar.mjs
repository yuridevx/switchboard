// Живой обход разделов выложенной страницы: node tools/fleet/live-bar.mjs <флот> <устройство> <машина> [вторая машина]
// Называет строки полосы отказов чтения («Не загрузилось: …») на каждом разделе: чтение, которое не проходит на исправном флоте, видно сразу.
// Раздел читается, когда его чтения ответили: знак aria-busy="false" у области экрана. Шаг на раздел; первый красный останавливает обход.
import { check } from "./harness.mjs";

await check(async (t) => {
  // свой разговор: раздел сессии читает её строку и историю — чужая сессия может уйти посреди обхода
  const s = await t.session({ name: "bar" });
  // «Расход» и «Аккаунты» (с них открывается «Флот») читают историю флота — она в ClickHouse
  const history = t.lacks("clickhouse") ? [] : ["/spend", "/fleet", "/fleet/accounts"];
  const routes = ["/work", "/work/" + s.callsign, "/archive", ...history, "/fleet/profiles", "/fleet/releases", "/factory", "/observe", "/observe/journal", "/observe/analytics", "/settings", "/settings/alerts", "/settings/people", "/settings/passes", "/settings/proxy", "/new", ...[t.machine, t.second].filter(Boolean).map((m) => "/machine/" + m)];
  let page;
  for (const r of routes) await t.step(r, async () => {
    page ??= await t.page({ width: 1280, height: 900 });
    // каждый раздел — с загрузки страницы по его адресу: область экрана новая, её знак не остался от прежнего раздела
    await page.goto(`${t.base}/#${r}`);
    await page.reload();
    await page.locator('.screen[aria-busy="false"]').waitFor({ state: "attached" });
    const bar = await page.locator(".banner.bad").allInnerTexts();
    if (bar.length) throw new Error(`строк полосы ${bar.length} · ${bar.join(" | ").slice(0, 400)}`);
    return "строк полосы 0";
  });
});
