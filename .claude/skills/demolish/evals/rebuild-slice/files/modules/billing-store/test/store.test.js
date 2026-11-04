import test from "node:test";
import assert from "node:assert/strict";
import { saveInvoice, loadInvoice, _rows } from "../index.js";
test("сохраняет строку во внутренний массив", () => {
  const before = _rows.length;
  saveInvoice({ amount: 1, total: 1.2 });
  assert.equal(_rows.length, before + 1);
});
test("читает сохранённое", () => {
  const r = saveInvoice({ amount: 2, total: 2.4 });
  assert.equal(loadInvoice(r.id).total, 2.4);
});
test("нет такой строки", () => {
  assert.equal(loadInvoice(-1), null);
});
