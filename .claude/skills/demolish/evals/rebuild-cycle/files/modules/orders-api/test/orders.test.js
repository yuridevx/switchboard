import test from "node:test";
import assert from "node:assert/strict";
import { placeOrder, listOrders, _lastRaw } from "../index.js";
test("заказ попадает в список", () => {
  const n = listOrders().length;
  placeOrder("чай");
  assert.equal(listOrders().length, n + 1);
});
test("заказ попадает в список ещё раз", () => {
  const n = listOrders().length;
  placeOrder("кофе");
  assert.equal(listOrders().length, n + 1);
});
test("сырая строка", () => { placeOrder("сок"); assert.equal(_lastRaw().item, "сок"); });
test("заказ без товара отказывает", () => { assert.throws(() => placeOrder(""), /no_item/); });
