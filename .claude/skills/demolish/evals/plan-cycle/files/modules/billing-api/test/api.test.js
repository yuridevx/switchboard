import test from "node:test";
import assert from "node:assert/strict";
import { createInvoice, getInvoice, refund } from "../index.js";
for (const [amount, total] of [[10, 12], [5, 6], [7.77, 9.32]]) {
  test("НДС 20% на " + amount, () => assert.equal(createInvoice(amount).total, total));
}
test("отказы словом", () => {
  assert.throws(() => createInvoice(-1), /bad_amount/);
  assert.throws(() => getInvoice(-1), /not_found/);
});
test("возврат один раз", () => {
  const { id } = createInvoice(1);
  refund(id);
  assert.equal(getInvoice(id).refunded, true);
  assert.throws(() => refund(id), /already_refunded/);
});
