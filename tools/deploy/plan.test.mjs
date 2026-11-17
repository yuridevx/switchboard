// Эталоны плана выкладки: node tools/test/run.mjs tools
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inputs } from "../build/digest.mjs";
import { nextBuild, plan } from "./plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stands = { platform: "p1", services: "s1", machines: "m1" };

test("нетронутое не выкладывается: изменилась только страница — идут одни службы", () => {
  assert.deepEqual(plan({ ...stands, services: "s2" }, stands), ["services"]);
  assert.deepEqual(plan(stands, stands), []);
});

test("порядок частей: платформа, службы со страницей, машины", () => {
  assert.deepEqual(plan({ machines: "m2", services: "s2", platform: "p2" }, stands), ["platform", "services", "machines"]);
});

test("повтор доводит: выкладка оборвалась после служб — второй запуск выкладывает только машины", () => {
  const tree = { platform: "p2", services: "s2", machines: "m2" };
  assert.deepEqual(plan(tree, { platform: "p2", services: "s2", machines: "m1" }), ["machines"]);
});

test("часть без отпечатка на флоте выкладывается: до первой выкладки отсюда службы о нём не отвечают", () => {
  assert.deepEqual(plan(stands, { machines: "m1" }), ["platform", "services"]);
});

test("договор — часть каждой: общий договор запросов собран в платформу, службы и машины", async () => {
  for (const part of ["platform", "services", "machines"]) {
    const files = await inputs(root, part);
    assert.ok(files.some((f) => f.includes("protocol/src/contracts/")), `в ${part} договора нет`);
  }
});

test("номер сборки — последний в каталоге плюс один", () => {
  assert.equal(nextBuild([{ build: 41 }, { build: 3 }, { build: 40 }]), 42);
  assert.equal(nextBuild([]), 1);
});
