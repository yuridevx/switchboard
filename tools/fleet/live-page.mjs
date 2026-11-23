// Живая проверка страницы на настоящем флоте: node tools/fleet/live-page.mjs <флот> <устройство с пропуском> <машина>
// Принимает приглашение в браузере, открывает сессию, пишет ей и ждёт ответа, сворачивает её дочернюю в списке, снимает с дочерней родителя.
// Снимки шагов — dist/live/page. Ошибка страницы или строка error её консоли — красный.
import path from "node:path";
import { check } from "./harness.mjs";
import { say, turn } from "./turn.mjs";

await check(async (t) => {
  // своя сессия на ключе флота: ответ модели не зависит от чужой сессии и её ключа
  const s = await t.session({ name: "live" });
  // дочерняя сессия той же: без сообщений, модель не зовётся — в списке она стоит под родителем
  const kid = await t.session({ name: "livek", cwd: s.cwd, parent: s.callsign });
  const word = "live" + t.tag;
  let page;
  const shot = (name) => page.screenshot({ path: path.join(t.shots(), name + ".png") });

  await t.step("приглашение принято, картина пришла", async () => {
    page = await t.page({ console: true });
    await page.getByText("Работа", { exact: true }).first().waitFor();
    await shot("1-home");
  });
  await t.step("сессия открыта из «Работы»", async () => {
    await page.goto(t.base + "/#/work/" + s.callsign);
    await page.getByPlaceholder(/Сообщение/).waitFor();
    await shot("2-session");
  });
  await t.step("сообщение отправлено и ответ модели пришёл в ленту", async () => {
    const box = page.getByPlaceholder(/Сообщение/);
    await box.fill(turn(say(word)));
    await box.press("Enter");
    await page.getByText("Ответь текстом: " + word).first().waitFor();
    // ответ модели повторяет слово проверки: оно должно появиться в ленте вне своего сообщения
    await page.waitForFunction((w) => [...document.querySelectorAll("p, li, span, div")].filter((e) => e.children.length === 0 && e.textContent.includes(w) && !e.textContent.includes("Ответь текстом")).length > 0, word);
    await shot("3-answered");
  });
  await t.step("родитель сворачивает дочернюю в свою строку; после перезагрузки страницы она свёрнута", async () => {
    const list = page.locator('section[aria-label="Работа"]');
    const row = list.locator(`.row[data-call="${kid.callsign}"]`);
    await row.waitFor();
    await list.getByRole("button", { name: "Свернуть дочерние: " + s.callsign }).click();
    await row.waitFor({ state: "detached" });
    await page.reload();
    // кнопка «Показать» стоит только у родителя со свёрнутой дочерней: дочерняя известна странице и в список не раскрыта
    await list.getByRole("button", { name: "Показать дочерние: " + s.callsign }).waitFor();
    if (await row.count()) throw new Error("после перезагрузки дочерняя раскрыта");
    await shot("4-folded");
  });
  await t.step("дочерняя сняла родителя инструментом session_update — в списке она встала в корень, у бывшего родителя сворачивать нечего", async () => {
    const res = await t.fetch(t.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t.key }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_update", arguments: { to: kid.callsign, patch: { parent: null } } } }) });
    const j = await res.json();
    if (j.error || j.result?.isError) throw new Error("session_update отказал: " + JSON.stringify(j.error ?? j.result).slice(0, 300));
    const list = page.locator('section[aria-label="Работа"]');
    // свёрнутая дочерняя вышла из-под родителя: её строка снова в списке, а кнопки «Показать дочерние» у родителя больше нет
    await list.locator(`.row[data-call="${kid.callsign}"]`).waitFor();
    await list.getByRole("button", { name: "Показать дочерние: " + s.callsign }).waitFor({ state: "detached" });
    await shot("5-root");
  });
  await t.step("экран «Наблюдение» показывает запросы", async () => {
    await page.goto(t.base + "/#/observe");
    await page.getByText("message").first().waitFor();
    await shot("6-observe");
  });
});
