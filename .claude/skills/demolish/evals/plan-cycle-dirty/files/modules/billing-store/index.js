// хранилище счетов: только для billing-api
export const _rows = [];
let lastId = 0;
function legacyRound(x) { return Number(x.toFixed(2)); }
export function saveInvoice(inv) {
  lastId = lastId + 1;
  const row = { ...inv, id: lastId, total: legacyRound(inv.total) };
  _rows.push(row);
  return row;
}
export function loadInvoice(id) {
  for (let i = 0; i < _rows.length; i++) {
    if (_rows[i].id === id) return _rows[i];
  }
  return null;
}
