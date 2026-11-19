// Эталоны сводки истории прогонов: node tools/test/run.mjs tools
import assert from "node:assert/strict";
import { test } from "node:test";
import { placeOf, render, summarize } from "./summary.mjs";

const step = (place, module, msg, ok) => ({ place, module, msg, ok });
const parts = (web = "success") => [{ name: "web · linux", conclusion: web }, { name: "host · windows", conclusion: "success" }, { name: "проверка", conclusion: web }];

// чьё: факт истории — 8 красных прогонов main из 63 на коде, который только что прошёл в запросе на слияние (17–19 нояб.)
test("плавает: шаг зелёный в запросе на слияние и красный на main при одном дереве кода — назван, с обоими прогонами", () => {
  const sum = summarize([
    { id: 1, workflow: "ci", event: "pull_request", tree: "t1", conclusion: "success", jobs: [...parts(), { name: "коробка 2/2", conclusion: "success" }], steps: [step("коробка linux", "флоу без окон", "1440 · аккаунты и провайдеры — формы на месте", true), step("коробка linux", "запросы", "whoami", true)] },
    { id: 2, workflow: "ci", event: "push", tree: "t1", conclusion: "failure", jobs: [...parts(), { name: "коробка 2/2", conclusion: "failure" }], steps: [step("коробка linux", "флоу без окон", "1440 · аккаунты и провайдеры — формы на месте", false), step("коробка linux", "запросы", "whoami", true)] },
  ]);
  assert.equal(sum.flaky.length, 1);
  assert.deepEqual(sum.flaky[0], { title: "коробка linux · флоу без окон › 1440 · аккаунты и провайдеры — формы на месте", ok: 1, bad: 1, runs: [1, 2] });
  assert.deepEqual(sum.main, { runs: 1, red: 1, redAfterGreen: 1 });
  assert.deepEqual(sum.places["коробка linux"], { jobs: 2, red: 1, steps: 4, redSteps: 1 });
});

// чьё: код — красное на другом дереве плавающим не считается: код изменился
test("другое дерево — не плавает: красный шаг на изменившемся коде остаётся красным шагом, и только", () => {
  const sum = summarize([
    { id: 1, workflow: "ci", event: "pull_request", tree: "t1", conclusion: "success", jobs: [{ name: "коробка 1/2", conclusion: "success" }], steps: [step("коробка linux", "тикеты", "тикет открыт", true)] },
    { id: 2, workflow: "ci", event: "pull_request", tree: "t2", conclusion: "failure", jobs: [{ name: "коробка 1/2", conclusion: "failure" }], steps: [step("коробка linux", "тикеты", "тикет открыт", false)] },
  ]);
  assert.equal(sum.flaky.length, 0);
  assert.equal(sum.places["коробка linux"].redSteps, 1);
  assert.deepEqual(sum.main, { runs: 0, red: 0, redAfterGreen: 0 });
});

// чьё: код — работа тестов части шагов не пишет: её исход и есть шаг
test("части: работа одной части с двумя исходами на одном дереве — плавает; сводная работа и отменённые в счёт не идут", () => {
  const sum = summarize([
    { id: 5, workflow: "ci", event: "pull_request", tree: "t9", conclusion: "failure", jobs: parts("failure"), steps: [] },
    { id: 6, workflow: "ci", event: "pull_request", tree: "t9", conclusion: "success", jobs: [...parts(), { name: "keeper · linux", conclusion: "cancelled" }], steps: [] },
  ]);
  assert.deepEqual(sum.places["части"], { jobs: 4, red: 1, steps: 0, redSteps: 0 });
  assert.deepEqual(sum.flaky.map((f) => f.title), ["части · web · linux"]);
});

// чьё: код — место живого флота называют его строки шагов
test("места: коробка по названию работы, живой флот — по строкам шагов; сводка называет каждое место строкой", () => {
  assert.equal(placeOf("ci", "коробка · windows 2/3"), "коробка windows");
  assert.equal(placeOf("ci", "коробка 1/2"), "коробка linux");
  assert.equal(placeOf("ci", "host · windows"), "части");
  assert.equal(placeOf("ci", "проверка"), null);
  const sum = summarize([{ id: 7, workflow: "deploy", event: "push", tree: "t3", conclusion: "failure", jobs: [{ name: "fleet", conclusion: "failure" }], steps: [step("флот test", "файлы сессии", "телефон", false)] }]);
  assert.deepEqual(sum.places["флот test"], { jobs: 1, red: 1, steps: 1, redSteps: 1 });
  assert.equal(render(sum), ["флот test · работ 1 · красных 1 · шагов 1 · красных шагов 1", "main · прогонов 0 · красных 0 · красных на дереве зелёного запроса 0", "плавает — один код, одно место, два исхода: 0"].join("\n"));
});
