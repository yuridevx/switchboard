// Правило хранения точек сессии: чистая функция над строками одной сессии; ею считаются и срок в списке, и уборка.
export type Node = { id: number; at: number; base: number | null };

const DAY = 86_400_000;
export const YEAR = 365 * DAY;
const MONTH = 30 * DAY;

const dayOf = (t: number) => t - (t % DAY);
/** Номер недели с понедельника: 1 января 1970 — четверг. */
const weekOf = (t: number) => Math.floor((Math.floor(t / DAY) + 3) / 7);

/** Последняя точка в каждой группе. */
function lastBy(nodes: Node[], group: (at: number) => number): Set<number> {
  const last = new Map<number, number>();
  for (const n of [...nodes].sort((a, b) => a.at - b.at || a.id - b.id)) last.set(group(n.at), n.id);
  return new Set(last.values());
}

/** Линия — точки от головы по основам. */
export function lineOf(nodes: Node[], head: number): Set<number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const line = new Set<number>();
  for (let n = byId.get(head); n; n = byId.get(n.base as number)) line.add(n.id);
  return line;
}

/**
 * Срок точки: голова — без срока (null). Линия редеет сама по себе: последняя в неделе — год от дня, в дне — 30 дней, прочие — два дня; ветка её дни не занимает.
 * Точки ветки — по дню; конец ветки и точка линии, от которой она ушла, держатся год от конца ветки.
 */
export function expiries(nodes: Node[], head: number): Map<number, number | null> {
  const line = lineOf(nodes, head);
  const onLine = nodes.filter((n) => line.has(n.id));
  const off = nodes.filter((n) => !line.has(n.id));
  const lineDays = lastBy(onLine, dayOf);
  const lineWeeks = lastBy(onLine, weekOf);
  const offDays = lastBy(off, dayOf);
  const until = new Map<number, number | null>();
  for (const n of onLine) until.set(n.id, dayOf(n.at) + (lineWeeks.has(n.id) ? YEAR : lineDays.has(n.id) ? MONTH : 2 * DAY));
  for (const n of off) until.set(n.id, dayOf(n.at) + (offDays.has(n.id) ? MONTH : 2 * DAY));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Set(nodes.map((n) => n.base));
  const hold = (id: number, t: number) => until.set(id, Math.max(until.get(id)!, t));
  for (const end of off.filter((n) => !parents.has(n.id))) {
    const t = end.at + YEAR;
    hold(end.id, t);
    let n: Node | undefined = end;
    while (n && !line.has(n.id)) n = byId.get(n.base as number);
    if (n) hold(n.id, t);
  }
  until.set(head, null);
  return until;
}
