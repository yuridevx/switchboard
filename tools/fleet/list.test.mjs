// Эталоны списка живых проверок: node tools/test/run.mjs tools
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALONE, BOX, FLEET, HAND, NOISY, PLACES, PROD, QUIET, rows, select } from "./list.mjs";

const SECOND = "вторая-машина";
const list = rows({ fleet: "test", device: "ci", machine: "первая", second: SECOND, pairs: ["box/m1", "box-openai/m2"] });
const words = (r) => r[4].split(" ");
const names = (rs) => rs.map((r) => r[0]);
/** Коробка: нет модели, которая понимает прочитанное, и уведомлений браузера (SB2_WITHOUT коробки). */
const boxLacks = (w) => ["mind", "push"].includes(w);

// чьё: решение развилки 1 дизайна «Тесты без случайности» (принято) — на живом флоте после слияния идут только швы
test("живой флот после слияния: идут только строки со словом «флот» — швы", () => {
  const got = select(list, { place: FLEET });
  assert.ok(got.every((r) => words(r).includes(FLEET)));
  assert.deepEqual(names(got), names(list.filter((r) => words(r).includes(FLEET))));
  assert.deepEqual(names(got).sort(), ["аккаунты и модели", "запросы", "оповещение о сбое", "ошибки на виду", "память флота", "связь сессий: правила после сжатия", "смена модели", "страница в браузере", "файлы сессии", "часы флота"].sort());
});

// чьё: решение развилки 1 дизайна — весь список на флоте остаётся ручным запуском
test("живой флот, весь список (SB2_ALL=1): ещё и «руками»; строки «только коробка» не идут никогда", () => {
  const got = select(list, { place: FLEET, all: true });
  assert.deepEqual(names(got), names(list.filter((r) => words(r).includes(FLEET) || words(r).includes(HAND))));
  const boxOnly = list.filter((r) => r[4] === BOX);
  assert.ok(boxOnly.length > 0);
  for (const r of boxOnly) assert.ok(!names(got).includes(r[0]), `${r[0]} — только коробка, а идёт на флоте`);
});

// чьё: код — флот в коробке гонит весь список до слияния; седьмое поле строки — что ей нужно от места
test("коробка: идёт всё со словом «коробка», кроме того, чему у места чего-то нет", () => {
  const got = select(list, { place: BOX, lacks: boxLacks });
  const want = list.filter((r) => words(r).includes(BOX) && !(r[6] ?? []).some(boxLacks));
  assert.deepEqual(names(got), names(want));
  // нужное, которого нет: строка не идёт, даже со словом «коробка»
  assert.ok(!names(select(list, { place: BOX, lacks: (w) => w === "install" })).includes("установка службы машины"));
});

// чьё: код — проверка прода: свои пробные сессии, чужие не трогает, машины не перезапускает
test("прод: идут только строки со словом «прод»", () => {
  const got = select(list, { place: PROD });
  assert.ok(got.length > 0);
  assert.deepEqual(names(got), names(list.filter((r) => words(r).includes(PROD))));
  for (const r of got) assert.equal(r[5], QUIET, `${r[0]}: на проде только тихие`);
});

// чьё: код — поле «где идёт» вместо пометки «годна проду»
test("у каждой строки поле «где идёт» — из известных слов; дорожка — одна из трёх; названия не повторяются", () => {
  for (const r of list) {
    assert.ok(words(r).length > 0 && words(r).every((w) => PLACES.includes(w)), `${r[0]}: «${r[4]}»`);
    assert.ok([QUIET, NOISY, ALONE].includes(r[5]), `${r[0]}: дорожка ${r[5]}`);
  }
  assert.equal(new Set(names(list)).size, list.length);
});

// чьё: дизайн «Тесты без случайности», шаг 6 — тихие идут разом на первой машине; вторая отдана шумной дорожке
test("тихая строка не называет вторую машину", () => {
  for (const r of list.filter((x) => x[5] === QUIET)) assert.ok(!r[2].includes(SECOND), `${r[0]}: тихая, а называет вторую машину`);
});

// чьё: код — работа CI делит список между коробками (SB2_SHARD)
test("доли: каждая выбранная строка попадает ровно в одну долю", () => {
  for (const [place, all] of [[BOX, false], [FLEET, false], [FLEET, true]]) {
    const whole = names(select(list, { place, all, lacks: boxLacks }));
    for (const shards of [1, 2, 3]) {
      const parts = Array.from({ length: shards }, (_, i) => names(select(list, { place, all, lacks: boxLacks, shard: i + 1, shards })));
      assert.deepEqual(parts.flat().sort(), [...whole].sort(), `${place} на ${shards} долях`);
    }
  }
});
