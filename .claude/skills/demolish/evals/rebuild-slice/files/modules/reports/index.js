import { getInvoice } from "../billing-api/index.js";
import { listOrders } from "../orders-api/index.js";
import { send } from "../shared-http/index.js";
export function monthlyTotal(ids) {
  const total = ids.map((id) => getInvoice(id).total).reduce((a, b) => a + b, 0);
  send("/report", { total, orders: listOrders().length });
  return Math.round(total * 100) / 100;
}
