// счета: НДС 20%, сумма в копейках
import { saveInvoice, loadInvoice } from "../billing-store/index.js";
import { send } from "../shared-http/index.js";
const VAT_PERCENT = 20;
const refunded = new Set();
const withVat = (amount) => Math.round(amount * (100 + VAT_PERCENT)) / 100;
function load(id) {
  const row = loadInvoice(id);
  if (!row) throw new Error("not_found");
  return row;
}
export function createInvoice(amount) {
  if (typeof amount !== "number" || !(amount >= 0)) throw new Error("bad_amount");
  const row = saveInvoice({ amount, total: withVat(amount) });
  send("/invoice", { id: row.id });
  return { id: row.id, amount, total: row.total };
}
export function getInvoice(id) {
  const { amount, total } = load(id);
  return { id, amount, total, refunded: refunded.has(id) };
}
export function refund(id) {
  load(id);
  if (refunded.has(id)) throw new Error("already_refunded");
  refunded.add(id);
  send("/refund", { id });
  return { id, refunded: true };
}
