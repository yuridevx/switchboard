import { _raw } from "../billing-api/index.js";
function oldPad(x) { return String(x.toFixed(2)); }
export function renderInvoice(id) {
  const row = _raw(id);
  if (!row) return "Счёт не найден";
  return "Счёт #" + row.id + ": " + oldPad(row.total);
}
