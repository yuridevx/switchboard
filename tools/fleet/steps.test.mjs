// Эталоны журнала шагов: node tools/test/run.mjs tools
import assert from "node:assert/strict";
import { test } from "node:test";
import { labelOf, readSteps, stepLines } from "./steps.mjs";

const ctx = { t: 1795262131000, place: "коробка linux", commit: "cd023190", run: 44585875108 };

// чьё: слово пользователя — наблюдаемость первой (15 нояб.); дизайн «Тесты без случайности», эталон «Строка шага»
test("строка шага: проверка из трёх шагов, один красный — три строки общей формы с проверкой, шагом, исходом, временем, местом и коммитом", () => {
  const out = [
    "✓ сессия открыта · rw-00eb64@m1 · 3100 мс",
    "✗ три хода правят один файл · файл после трёх ходов: \"\"",
    "✓ показ: записи и файлы до отката, ничего не тронуто · 461 мс",
    "строка без отметки шагом не считается",
  ].join("\n");
  const lines = stepLines("откат разговора", out, 1, "", ctx);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { t: ctx.t, part: "check", module: "откат разговора", place: "коробка linux", commit: "cd023190", run: 44585875108, level: "info", msg: "сессия открыта", ok: true, ms: 3100 });
  assert.deepEqual(lines[1], { t: ctx.t, part: "check", module: "откат разговора", place: "коробка linux", commit: "cd023190", run: 44585875108, level: "error", msg: "три хода правят один файл", ok: false, why: 'файл после трёх ходов: ""' });
  assert.equal(lines[2].msg, "показ: записи и файлы до отката, ничего не тронуто");
  // файл строк читается обратно теми же строками
  assert.deepEqual(readSteps(lines.map((l) => JSON.stringify(l)).join("\n") + "\nне строка\n"), lines);
});

// чьё: код — шаги страницы называют ширину экрана первой: «1440 · название · причина»
test("название шага с шириной экрана: ширина входит в название", () => {
  assert.equal(labelOf("1440 · новая сессия — страница · locator.waitFor: Timeout 8000ms exceeded."), "1440 · новая сессия — страница");
  assert.equal(labelOf("390 · сведения о сессии — страница"), "390 · сведения о сессии — страница");
  assert.equal(labelOf("скрипт на машине m1"), "скрипт на машине m1");
});

// чьё: факт истории — «разделы страницы» дважды роняли main, не назвав красного шага (18 нояб., прогоны 44268467035 и 44268574923)
test("проверка упала мимо шагов: красная строка о самой проверке — со словами ошибки; снята по пределу — со словом предела", () => {
  const thrown = stepLines("разделы страницы", "✓ /work · строк полосы 0\n", 1, "TimeoutError: page.goto: Timeout 30000ms exceeded.", ctx);
  assert.equal(thrown.length, 2);
  assert.deepEqual({ msg: thrown[1].msg, ok: thrown[1].ok, why: thrown[1].why }, { msg: "проверка дошла до конца", ok: false, why: "TimeoutError: page.goto: Timeout 30000ms exceeded." });
  const killed = stepLines("файлы сессии", "", null, "", ctx);
  assert.deepEqual({ msg: killed[0].msg, ok: killed[0].ok, why: killed[0].why }, { msg: "проверка дошла до конца", ok: false, why: "предел проверки вышел" });
  // красный шаг уже есть — второй красной строки о проверке нет
  assert.equal(stepLines("тикеты", "✗ тикет встал · не дождался", 1, "", ctx).length, 1);
  // зелёная проверка — только её шаги
  assert.equal(stepLines("запросы", "✓ whoami · 12 мс\n✓ картина · машин 2", 0, "", ctx).length, 2);
});

// чьё: код — журнал прогона прода открыт всем: в него идут только названия шагов и числа
test("прод: причина отказа в строку не идёт", () => {
  const [line] = stepLines("страница в браузере", "✗ вход по приглашению · пропуск sb2:…", 1, "", { ...ctx, place: "флот prod", bare: true });
  assert.equal(line.ok, false);
  assert.equal("why" in line, false);
});
