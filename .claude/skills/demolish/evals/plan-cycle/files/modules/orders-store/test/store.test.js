import test from "node:test";
import assert from "node:assert/strict";
import { putOrder, _rows } from "../index.js";
test("кладёт во внутренний массив", () => {
  const n = _rows.length;
  putOrder({ item: "чай" });
  assert.equal(_rows.length, n + 1);
});
test("модуль загружается", () => { assert.ok(true); });
