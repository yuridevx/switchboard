// Правило хранения точек сессии: чистая функция над строками одной сессии; ею считаются и срок в списке, и уборка.
export type Node = { id: number; at: number; base: number | null };

const DAY = 86_400_000;
export const YEAR = 365 * DAY;
const MONTH = 30 * DAY;

const dayOf = (t: number) => t - (t % DAY);
/** Номер недели с понедельника: 1 января 1970 — четверг. */
const weekOf = (t: number) => Math.floor((Math.floor(t / DAY) + 3) / 7);

/** Линия — точки от головы по основам. */
export function lineOf(nodes: Node[], head: number): Set<number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const line = new Set<number>();
  for (let n = byId.get(head); n; n = n.base === null ? undefined : byId.get(n.base)) line.add(n.id);
  return line;
}

/**
 * Срок точки: голова — без срока (null); последняя в неделе — год от дня; последняя в дне — 30 дней; прочие — два дня.
 * Конец ветки и точка линии, от которой ветка ушла, держатся год от конца ветки.
 */
export function expiries(nodes: Node[], head: number): Map<number, number | null> {
  const lastInDay = new Map<number, number>();
  const lastInWeek = new Map<number, number>();
  for (const n of [...nodes].sort((a, b) => a.at - b.at || a.id - b.id)) {
    lastInDay.set(dayOf(n.at), n.id);
    lastInWeek.set(weekOf(n.at), n.id);
  }
  const until = new Map<number, number | null>();
  for (const n of nodes) {
    const keep = lastInWeek.get(weekOf(n.at)) === n.id ? YEAR : lastInDay.get(dayOf(n.at)) === n.id ? MONTH : 2 * DAY;
    until.set(n.id, dayOf(n.at) + keep);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const line = lineOf(nodes, head);
  const parents = new Set(nodes.map((n) => n.base));
  const hold = (id: number, t: number) => until.set(id, Math.max(until.get(id)!, t));
  for (const end of nodes) {
    if (parents.has(end.id) || line.has(end.id)) continue;
    const t = end.at + YEAR;
    hold(end.id, t);
    let n: Node | undefined = end;
    while (n && !line.has(n.id)) n = n.base === null ? undefined : byId.get(n.base);
    if (n) hold(n.id, t);
  }
  until.set(head, null);
  return until;
}
