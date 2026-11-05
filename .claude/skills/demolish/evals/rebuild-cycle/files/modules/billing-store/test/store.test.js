import test from "node:test";
import assert from "node:assert/strict";
import { saveInvoice, loadInvoice } from "../index.js";
test("читает сохранённое, а чужого нет", () => {
  const row = saveInvoice({ amount: 2, total: 2.4 });
  assert.equal(loadInvoice(row.id).total, 2.4);
  assert.equal(loadInvoice(-1), null);
});
