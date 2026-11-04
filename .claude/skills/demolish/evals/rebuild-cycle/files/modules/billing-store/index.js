// хранилище счетов
const rows = new Map();
let lastId = 0;
export function saveInvoice(invoice) {
  const row = { ...invoice, id: ++lastId };
  rows.set(row.id, row);
  return row;
}
export function loadInvoice(id) {
  return rows.get(id) ?? null;
}
