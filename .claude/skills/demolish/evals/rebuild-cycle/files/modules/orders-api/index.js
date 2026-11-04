import { putOrder, allOrders, _rows, _validate } from "../orders-store/index.js";
import { send } from "../shared-http/index.js";
function oldCheck(item) {
  if (!item) throw new Error("no_item");
  if (typeof item !== "string") throw new Error("no_item");
  if (item === "") throw new Error("no_item");
  return item;
}
// то же правило, что и в хранилище: латали с двух сторон
export function placeOrder(item) {
  oldCheck(item);
  _validate({ item });
  const id = putOrder({ item });
  send("/order", { id });
  return { id, item };
}
export function listOrders() { return allOrders(); }
export function _lastRaw() { return _rows[_rows.length - 1]; }
