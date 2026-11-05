import { getInvoice } from "../billing-api/index.js";
export function renderInvoice(id) {
  try {
    const { total } = getInvoice(id);
    return "Счёт #" + id + ": " + total.toFixed(2);
  } catch {
    return "Счёт не найден";
  }
}
