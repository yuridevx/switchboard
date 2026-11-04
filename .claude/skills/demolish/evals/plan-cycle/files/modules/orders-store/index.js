// заказы: только для orders-api; много раз латали
export const _rows = [];
function oldCopy(x) { return JSON.parse(JSON.stringify(x)); }
export function _validate(o) {
  if (!o) throw new Error("no_item");
  if (!o.item) throw new Error("no_item");
  if (o.item === "") throw new Error("no_item");
  return o;
}
export function putOrder(o) {
  _validate(o);
  _rows.push(oldCopy(o));
  return _rows.length;
}
export function allOrders() {
  const out = [];
  for (let i = 0; i < _rows.length; i++) out.push(oldCopy(_rows[i]));
  return out;
}
