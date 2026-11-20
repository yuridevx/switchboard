// Эталоны журнала шагов: node tools/test/run.mjs tools
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSteps, stamp } from "./steps.mjs";

const ctx = { t: 1795262131000, place: "коробка linux", commit: "cd023190", run: 44585875108 };
/** Строка шага, какой её пишет проверка (вход check обвязки). */
const step = (msg, ok, more = {}) => ({ t: 1795262130000, level: ok ? "info" : "error", part: "check", module: "откат разговора", msg, ok, ...more });

// чьё: слово пользователя — наблюдаемость первой (15 нояб.); дизайн «Тесты без случайности», эталон «Строка шага»
test("строка шага: проверка из трёх шагов, один красный — три строки общей формы с проверкой, шагом, исходом, временем, местом и коммитом", () => {
  const told = [step("сессия открыта", true, { ms: 3100 }), step("три хода правят один файл", false, { why: 'файл после трёх ходов: ""' }), step("показ: записи и файлы до отката, ничего не тронуто", true, { ms: 461 })];
  // файл строк проверки читается обратно теми же строками; чужая строка пропускается
  const read = readSteps(told.map((l) => JSON.stringify(l)).join("\n") + "\nне строка\n");
  assert.deepEqual(read, told);
  const lines = stamp("откат разговора", read, 1, "", ctx);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { t: 1795262130000, level: "info", part: "check", module: "откат разговора", msg: "сессия открыта", ok: true, ms: 3100, place: "коробка linux", commit: "cd023190", run: 44585875108 });
  assert.deepEqual(lines[1], { t: 1795262130000, level: "error", part: "check", module: "откат разговора", msg: "три хода правят один файл", ok: false, place: "коробка linux", commit: "cd023190", run: 44585875108, why: 'файл после трёх ходов: ""' });
  assert.equal(lines[2].msg, "показ: записи и файлы до отката, ничего не тронуто");
});

// чьё: факт истории — «разделы страницы» дважды роняли main, не назвав красного шага (18 нояб., прогоны 44268467035 и 44268574923)
test("проверка упала мимо шагов: красная строка о самой проверке — со словами ошибки; не отдала ни строки или снята по пределу — тоже", () => {
  const thrown = stamp("разделы страницы", [step("/work", true)], 1, "TimeoutError: page.goto: Timeout 30000ms exceeded.", ctx);
  assert.equal(thrown.length, 2);
  assert.deepEqual({ module: thrown[1].module, msg: thrown[1].msg, ok: thrown[1].ok, why: thrown[1].why }, { module: "разделы страницы", msg: "проверка дошла до конца", ok: false, why: "TimeoutError: page.goto: Timeout 30000ms exceeded." });
  // ни одной строки и не ноль — красная строка о проверке
  const silent = stamp("серверные функции", [], 1, "Error: Cannot find module", ctx);
  assert.deepEqual(silent.map((l) => [l.msg, l.ok, l.why]), [["проверка дошла до конца", false, "Error: Cannot find module"]]);
  const killed = stamp("файлы сессии", [], null, "", ctx);
  assert.deepEqual({ msg: killed[0].msg, ok: killed[0].ok, why: killed[0].why }, { msg: "проверка дошла до конца", ok: false, why: "предел проверки вышел" });
  // красный шаг уже есть — второй красной строки о проверке нет
  assert.equal(stamp("тикеты", [step("тикет встал", false, { why: "не дождался" })], 1, "", ctx).length, 1);
  // зелёная проверка — только её шаги
  assert.equal(stamp("запросы", [step("whoami", true), step("картина", true)], 0, "", ctx).length, 2);
});

// чьё: код — журнал прогона прода открыт всем: в него идут только названия шагов и числа
test("прод: причина отказа в строку не идёт", () => {
  const [line] = stamp("страница в браузере", [step("вход по приглашению", false, { why: "пропуск sb2:…" })], 1, "", { ...ctx, place: "флот prod", bare: true });
  assert.equal(line.ok, false);
  assert.equal("why" in line, false);
});
