// Правило хранения точек; считает его только этот модуль. Сутки — по UTC, неделя — с понедельника.
//   сегодня и вчера — все точки; до 30 дней — последняя точка линии в дне; до года — последняя точка линии в неделе;
//   всегда — голова; год — конец каждой ветки и точка линии, от которой ветка ушла; сессия без новых точек год уходит целиком.
const DAY = 86_400_000;
const YEAR = 365 * DAY;
const dayOf = (at: number) => Math.floor(at / DAY);
/** 1 января 1970 — четверг: сдвиг на 3 дня начинает неделю с понедельника. */
const weekOf = (at: number) => Math.floor((dayOf(at) + 3) / 7);

export type Node = { id: number; at: number; base: number | null };

/** Линия: от головы назад по base. */
export function lineOf(points: Node[], head: number): Set<number> {
  const byId = new Map(points.map((p) => [p.id, p]));
  const line = new Set<number>();
  for (let p = byId.get(head); p && !line.has(p.id); p = p.base === null ? undefined : byId.get(p.base)) line.add(p.id);
  return line;
}

/** Последняя точка в каждой группе. */
function latestBy(points: Node[], key: (at: number) => number): Set<number> {
  const latest = new Map<number, Node>();
  for (const p of points) {
    const seen = latest.get(key(p.at));
    if (!seen || p.at > seen.at || (p.at === seen.at && p.id > seen.id)) latest.set(key(p.at), p);
  }
  return new Set([...latest.values()].map((p) => p.id));
}

/** Срок точек, которые держат ветки: конец ветки и точка линии, откуда она ушла, — год от конца ветки. */
function branchHolds(points: Node[], head: number, line: Set<number>): Map<number, number> {
  const byId = new Map(points.map((p) => [p.id, p]));
  const parents = new Set(points.map((p) => p.base));
  const holds = new Map<number, number>();
  const hold = (id: number, until: number) => holds.set(id, Math.max(holds.get(id) ?? 0, until));
  for (const end of points) {
    if (end.id === head || parents.has(end.id)) continue;
    const until = end.at + YEAR;
    hold(end.id, until);
    let p = end;
    const walked = new Set([end.id]);
    while (p.base !== null) {
      const up = byId.get(p.base);
      if (!up || walked.has(up.id)) break;
      if (line.has(up.id)) {
        hold(up.id, until);
        break;
      }
      walked.add(up.id);
      p = up;
    }
  }
  return holds;
}

/** До какого мига хранится каждая точка сессии; null — голова: пока сессия жива. */
export function expiry(points: Node[], head: number): Map<number, number | null> {
  const line = lineOf(points, head);
  const onLine = points.filter((p) => line.has(p.id));
  const lastOfDay = latestBy(onLine, dayOf);
  const lastOfWeek = latestBy(onLine, weekOf);
  const holds = branchHolds(points, head, line);
  return new Map(
    points.map((p) => {
      if (p.id === head) return [p.id, null];
      const day = dayOf(p.at);
      const days = lastOfWeek.has(p.id) ? 365 : lastOfDay.has(p.id) ? 30 : 2;
      return [p.id, Math.max((day + days) * DAY, holds.get(p.id) ?? 0)];
    }),
  );
}

/** Какие точки уходят в миг now. */
export function expired(points: Node[], head: number, now: number): number[] {
  const top = points.find((p) => p.id === head);
  if (!top || now - top.at >= YEAR) return points.map((p) => p.id);
  const until = expiry(points, head);
  return points.filter((p) => (until.get(p.id) ?? Infinity) <= now).map((p) => p.id);
}
