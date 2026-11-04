// заказы: только для orders-api
const rows = [];
function oldCopy(x) { return JSON.parse(JSON.stringify(x)); }
export function putOrder(o) { rows.push(oldCopy(o)); return rows.length; }
export function allOrders() { return rows.map(oldCopy); }
