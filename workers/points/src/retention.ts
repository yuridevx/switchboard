// Правило хранения точек сессии: чистая функция над строками. Голова живёт, пока идёт сессия; линия редеет: день → 30 дней → неделя → год;
// конец ветки и точка линии, от которой она ушла, — год от конца ветки; средняя точка ветки — по дню.
export type Node = { id: number; at: number; base: number | null };

const DAY = 86_400_000;
export const YEAR = 365 * DAY;

const dayOf = (at: number) => Math.floor(at / DAY) * DAY;
/** Понедельник недели: 1 января 1970 — четверг. */
const weekOf = (at: number) => dayOf(at) - ((new Date(at).getUTCDay() + 6) % 7) * DAY;

/** Последняя точка в каждой группе. */
function lastBy(nodes: Node[], group: (at: number) => number): Set<number> {
  const last = new Map<number, Node>();
  for (const n of nodes) {
    const was = last.get(group(n.at));
    if (!was || n.at >= was.at) last.set(group(n.at), n);
  }
  return new Set([...last.values()].map((n) => n.id));
}

/** Линия — путь от головы по основам. */
export function lineOf(nodes: Node[], head: number): Set<number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const line = new Set<number>();
  for (let n = byId.get(head); n; n = n.base === null ? undefined : byId.get(n.base)) line.add(n.id);
  return line;
}

/** Срок каждой точки: миг, с которого её можно убрать; голова — null. */
export function expiries(nodes: Node[], head: number): Map<number, number | null> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const line = lineOf(nodes, head);
  const onLine = nodes.filter((n) => line.has(n.id));
  const off = nodes.filter((n) => !line.has(n.id));
  const lineDays = lastBy(onLine, dayOf);
  const lineWeeks = lastBy(onLine, weekOf);
  const offDays = lastBy(off, dayOf);
  const until = new Map<number, number | null>();
  for (const n of onLine) until.set(n.id, dayOf(n.at) + (lineWeeks.has(n.id) ? YEAR : (lineDays.has(n.id) ? 30 : 2) * DAY));
  for (const n of off) until.set(n.id, dayOf(n.at) + (offDays.has(n.id) ? 30 : 2) * DAY);

  const parents = new Set(nodes.map((n) => n.base));
  for (const end of off.filter((n) => !parents.has(n.id))) {
    const year = end.at + YEAR;
    until.set(end.id, year);
    let n: Node | undefined = end;
    while (n && !line.has(n.id)) n = n.base === null ? undefined : byId.get(n.base);
    if (n) until.set(n.id, Math.max(until.get(n.id) as number, year));
  }
  until.set(head, null);
  return until;
}

/** Основа точки после уборки: ближайший уцелевший предок. */
export function survivingBase(n: Node, byId: Map<number, Node>, gone: Set<number>): number | null {
  let base = n.base;
  while (base !== null && gone.has(base)) base = byId.get(base)?.base ?? null;
  return base;
}
