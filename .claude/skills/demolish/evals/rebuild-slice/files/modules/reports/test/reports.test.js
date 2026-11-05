import test from "node:test";
import assert from "node:assert/strict";
import { createInvoice } from "../../billing-api/index.js";
import { monthlyTotal } from "../index.js";
test("отчёт складывает счета с НДС", () => {
  const a = createInvoice(10), b = createInvoice(5);
  assert.equal(monthlyTotal([a.id, b.id]), 18);
});
