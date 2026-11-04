import test from "node:test";
import assert from "node:assert/strict";
import { placeOrder, listOrders } from "../index.js";
test("заказ попадает в список", () => {
  const n = listOrders().length;
  placeOrder("чай");
  assert.equal(listOrders().length, n + 1);
});
test("заказ без товара отказывает", () => { assert.throws(() => placeOrder(""), /no_item/); });
