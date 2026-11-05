import test from "node:test";
import assert from "node:assert/strict";
import { createInvoice } from "../../billing-api/index.js";
import { renderInvoice } from "../index.js";
test("показывает счёт", () => {
  const i = createInvoice(10);
  assert.equal(renderInvoice(i.id), "Счёт #" + i.id + ": 12.00");
});
test("показывает, что счёта нет", () => { assert.equal(renderInvoice(-1), "Счёт не найден"); });
