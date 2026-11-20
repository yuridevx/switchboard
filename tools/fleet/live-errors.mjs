// Живая проверка «Ошибки на виду»: node tools/fleet/live-errors.mjs [флот] [устройство] [машина]
// Сессия на дешёвой модели (SB2_KEY и SB2_MODEL, по умолчанию claude и claude-haiku-5-5) получает негодный PDF — провайдер отклоняет вызов.
// Проверяет: причина словами провайдера стоит в журнале машины, в ленте сессии (история отдаёт её на месте) и на выложенной странице — до и после перезагрузки.
// SB2_GOAL_KEY и SB2_GOAL_MODEL (ключ и модель Meta) — ещё и проверка цели: «/goal» на Meta проходит, отказов провайдера и сбоя хука нет.
// Снимки — dist/live/errors.
import path from "node:path";
import { check } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

const REFUSED = "вызов модели отклонён (4";
const DOC = { key: process.env.SB2_KEY ?? "claude", model: process.env.SB2_MODEL ?? "claude-haiku-5-5" };

await check(async (t) => {
  let s, page;
  let line = "";
  const logsOf = async (x) => (await x.history()).filter((e) => e.type === "log");

  await t.step("сессия на дешёвой модели открыта", async () => {
    s = await t.session({ name: "err", ...DOC });
    return `${s.callsign} · ${DOC.key}/${DOC.model}`;
  });

  await t.step("провайдер отклонил вызов: причина его словами — событием log в ленте сессии", async () => {
    // заголовок PDF настоящий, тело — нет: сессия отдаёт файл провайдеру документом, и тот его отклоняет
    const pdf = await t.put("broken.pdf", Buffer.from("%PDF-1.7\n%âãÏÓ\nэто не PDF " + t.tag + "\n%%EOF\n"));
    // файл сообщения встаёт в uploads/ папки сессии; негодный PDF провайдер отклоняет, когда сессия его читает
    await s.turn(script(tool("Read", { file_path: `${s.cwd}/uploads/broken.pdf` }), say("прочитано")), { files: [pdf] });
    let logs = [];
    const refused = await t.wait("строка отказа в ленте", async () => {
      logs = await logsOf(s);
      return logs.find((e) => e.msg === "call" && String(e.why ?? "").startsWith(REFUSED));
    }, () => `строки беды в ленте: ${logs.map((e) => e.msg).join(", ") || "нет"}`);
    // причина — не один статус: за двоеточием стоят слова провайдера
    const said = String(refused.why).split("): ")[1] ?? "";
    if (said.length < 8) throw new Error(`в строке нет слов провайдера: ${refused.why}`);
    line = String(refused.why);
    return `${refused.level} · ${line.slice(0, 160)}`;
  });

  await t.step("журнал машины: строка вызова с отказом несёт причину — 1 из 1", async () => {
    const lines = await t.wait("строка вызова с отказом в журнале машины", async () => {
      const got = (await t.must("machine.journal", { to: "@" + t.machine, session: s.callsign, level: "warn", limit: 50 })).lines.filter((l) => l.msg === "call");
      return got.length && got;
    });
    const withWhy = lines.filter((l) => String(l.why ?? "").startsWith(REFUSED) && String(l.why).includes("): "));
    if (withWhy.length !== lines.length) throw new Error(`строк вызова с отказом ${lines.length}, с причиной ${withWhy.length}`);
    return `строк вызова с отказом ${lines.length}, с причиной ${withWhy.length}`;
  });

  // у одних провайдеров отказ обрывает ход, у других claude повторяет вызов без негодного файла и ход кончается ответом: строк «ход остановлен» — ровно по числу оборванных ходов
  await t.step("ход остановлен — строкой error в ленте, по одной на оборванный ход", async () => {
    const count = (h) => ({ ended: h.filter((e) => e.type === "result" && e.is_error).length, stopped: h.filter((e) => e.type === "log" && e.level === "error" && e.msg === "sdk.result") });
    // строка «ход остановлен» встаёт в ленту вслед за итогом оборванного хода: ждём её, а не читаем ленту один раз
    const got = await t.wait("строки «ход остановлен» по числу оборванных ходов", async () => {
      const n = count(await s.history());
      return n.stopped.length >= n.ended && n;
    });
    if (got.stopped.length !== got.ended) throw new Error(`оборванных ходов ${got.ended}, строк «ход остановлен» ${got.stopped.length}: ${JSON.stringify((await logsOf(s)).map((e) => e.msg))}`);
    return got.ended ? String(got.stopped[0].why).slice(0, 140) : "ход не оборвался: claude повторил вызов без файла и ответил";
  });

  await t.step("история отдаёт строку на месте: за сообщением человека, перед итогом хода", async () => {
    const h = await s.history();
    const at = h.findIndex((e) => e.type === "log" && e.why === line);
    const asked = h.findIndex((e) => e.type === "user" && JSON.stringify(e.message ?? {}).includes("Ответь текстом: прочитано"));
    if (at < 0 || asked < 0 || at < asked) throw new Error(`строка на месте ${at}, сообщение человека на месте ${asked}`);
    return `сообщение — ${asked}, строка — ${at} из ${h.length}`;
  });

  // строки беды в ленте страницы; своя — та, что начинается словами отказа
  const rows = () => page.locator(".sysline.tone-wait, .sysline.tone-bad");
  const mine = () => rows().filter({ hasText: line.slice(0, 60) }).first();
  await t.step("страница: причина отказа в ленте сессии — 1 из 1", async () => {
    page = await t.page({ width: 1280, height: 900, colorScheme: "light" });
    await page.goto(t.base + "/#/work/" + s.callsign);
    await mine().waitFor({ state: "attached" });
    await page.screenshot({ path: path.join(t.shots(), `errors-${t.machine}-1280-light.png`) });
    return `строк беды ${await rows().count()}`;
  });
  await t.step("страница перезагружена: причина на месте — 1 из 1", async () => {
    await page.reload();
    await mine().waitFor({ state: "attached" });
    const n = await rows().count();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    // снимок — когда страница уже встала в новую ширину и тёмную тему
    await page.waitForFunction(() => innerWidth === 390 && matchMedia("(prefers-color-scheme: dark)").matches);
    await page.screenshot({ path: path.join(t.shots(), `errors-${t.machine}-390-dark.png`) });
    return `строк беды ${n}`;
  });

  if (process.env.SB2_GOAL_KEY) {
    const goalDoc = { key: process.env.SB2_GOAL_KEY, model: process.env.SB2_GOAL_MODEL ?? "muse-spark-1.3" };
    await t.step("проверка цели на Meta проходит: отказов провайдера и сбоя хука нет — 0 из 1", async () => {
      const goal = await t.session({ name: "goal", ...goalDoc });
      // команда цели — свой ход claude: вопрос уходит, когда её итог уже в истории
      await goal.turn("/goal В ответе есть слово ok");
      await goal.turn("Ответь одним словом: ok");
      const logs = await logsOf(goal);
      const refusals = logs.filter((e) => e.msg === "call");
      const hook = logs.filter((e) => /hook error/i.test(String(e.why ?? "")));
      if (refusals.length || hook.length) throw new Error(`отказов провайдера ${refusals.length}, сбоев хука ${hook.length}: ${String((refusals[0] ?? hook[0]).why).slice(0, 200)}`);
      return `${goal.callsign} · ${goalDoc.key}/${goalDoc.model} · строк беды ${logs.length}`;
    });
  }
});
