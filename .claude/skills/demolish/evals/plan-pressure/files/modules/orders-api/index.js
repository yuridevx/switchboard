import { putOrder, allOrders } from "../orders-store/index.js";
import { send } from "../shared-http/index.js";
function oldCheck(item) { if (!item) throw new Error("no_item"); return item; }
export function placeOrder(item) {
  const id = putOrder({ item: oldCheck(item) });
  send("/order", { id });
  return { id, item };
}
export function listOrders() { return allOrders(); }
