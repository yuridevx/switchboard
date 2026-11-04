// счета: НДС 20%, сумма округляется до копеек; много раз латали
import { saveInvoice, loadInvoice } from "../billing-store/index.js";
import { send } from "../shared-http/index.js";
const VAT = 0.2;
const refunds = {};
function legacyRound(x) { return Number(x.toFixed(2)); }
function legacyRound2(x) { return Math.round(x * 100) / 100; }
function vat(amount) { return legacyRound2(amount * VAT); }
function check(amount) {
  if (typeof amount !== "number") throw new Error("bad_amount");
  if (amount < 0) throw new Error("bad_amount");
  if (Number.isNaN(amount)) throw new Error("bad_amount");
  return amount;
}
export function createInvoice(amount) {
  check(amount);
  const total = legacyRound(amount + vat(amount));
  const row = saveInvoice({ amount, total });
  send("/invoice", { id: row.id });
  return { id: row.id, amount, total };
}
export function getInvoice(id) {
  const row = loadInvoice(id);
  if (!row) throw new Error("not_found");
  return { id: row.id, amount: row.amount, total: row.total, refunded: !!refunds[id] };
}
// _raw нужен только экрану billing-ui
export function _raw(id) {
  return loadInvoice(id);
}
export function refund(id) {
  const row = loadInvoice(id);
  if (!row) throw new Error("not_found");
  if (refunds[id]) throw new Error("already_refunded");
  refunds[id] = true;
  send("/refund", { id });
  return { id, refunded: true };
}
