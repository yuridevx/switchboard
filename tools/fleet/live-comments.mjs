// Живая проверка комментариев к странице: node tools/fleet/live-comments.mjs <флот> <устройство>
// В браузере: Ctrl+C, клик по элементу, текст, «Передать Claude»; пачка — событием comments журнала флота, которое читает сторож comments.ts.
import { check } from "./harness.mjs";

await check(async (t) => {
  const word = "проверка-" + t.tag;
  let page, before;

  await t.step("режим комментариев включается по Ctrl+C", async () => {
    page = await t.page({ width: 1440, height: 900 });
    // экран с постоянным адресом: «Работа» сама переходит к свежей сессии, а рядом идут другие проверки и открывают свои
    await page.goto(`${t.base}/#/settings`);
    await page.getByRole("heading", { name: "Настройки" }).first().waitFor();
    await page.locator('.screen[aria-busy="false"]').waitFor({ state: "attached" });
    // комментарии подключаются отдельным куском сборки: Ctrl+C слушают, когда их панель встала в страницу
    await page.locator(".pc-bar").waitFor({ state: "attached" });
    await page.keyboard.press("Control+KeyC");
    await page.locator("body.pc-on").waitFor({ state: "attached" });
  });
  await t.step("клик в режиме комментариев не доходит до страницы", async () => {
    before = page.url();
    await page.locator("nav a").first().click();
    // клик забрали комментарии: открылось их поле, а переход не случился
    await page.locator(".pc-pop textarea").waitFor();
    if (page.url() !== before) throw new Error(`клик в режиме комментариев дошёл до страницы: ${page.url()}`);
  });
  await t.step("пачка ушла со страницы", async () => {
    await page.fill(".pc-pop textarea", word);
    await page.click('.pc-pop [data-a="ok"]');
    await page.click('.pc-bar [data-pc="send"]');
    // ушла — кнопки «Передать Claude» больше нет; не ушла — список с причиной
    await page.locator('.pc-bar:not(:has([data-pc="send"])), .pc-list small').first().waitFor({ state: "attached" });
    const failed = await page.locator(".pc-list small").allInnerTexts();
    if (failed.length) throw new Error(failed.join(" | "));
  });
  await t.step("комментарий со страницы дошёл сторожу пачкой", async () => {
    // сторож читает события comments журнала флота: свою пачку проверка находит по своему слову
    const note = await t.wait(`пачка со словом ${word} в журнале флота`, async () => {
      const { events } = await t.must("ledger.read", { what: "comments", limit: 50 });
      return events.flatMap((e) => e.data?.comments ?? []).find((n) => n.text === word);
    });
    if (!note.where?.element) throw new Error(`у комментария нет элемента: ${JSON.stringify(note.where).slice(0, 200)}`);
    return `элемент «${note.where.element.slice(0, 40)}» · экран ${note.where.hash || "#"}`;
  });
});
