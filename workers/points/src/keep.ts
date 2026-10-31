// Правило хранения точек — одно, и считает его только points. Сутки по UTC, неделя — с понедельника.
//   сегодня и вчера — все точки;
//   моложе 30 дней — последняя точка линии в каждом дне;
//   моложе года — последняя точка линии в каждой неделе;
//   всегда — голова; год — конец каждой ветки и точка линии, от которой ветка ушла;
//   сессия без новых точек год — уходит целиком.

export const DAY = 86_400_000;
export const YEAR = 365 * DAY;

export const dayOf = (t: number) => Math.floor(t / DAY);
/** Номер недели с понедельника: 1 января 1970 — четверг, поэтому сдвиг на 3 дня. */
export const weekOf = (t: number) => Math.floor((dayOf(t) + 3) / 7);
const dayStart = (d: number) => d * DAY;

export type P = { id: number; at: number; base: number | null };

/** Линия: путь от головы назад по base. */
export function lineOf(points: P[], head: number): Set<number> {
  const byId = new Map(points.map((p) => [p.id, p]));
  const line = new Set<number>();
  for (let c: number | null = head; c !== null && byId.has(c) && !line.has(c); c = byId.get(c)!.base) line.add(c);
  return line;
}

/**
 * До какого времени хранится каждая точка сессии (мс): после этого мига уборка её уберёт.
 * null — голова: хранится, пока сессия жива.
 */
export function untilOf(points: P[], head: number): Map<number, number | null> {
  const byId = new Map(points.map((p) => [p.id, p]));
  const line = lineOf(points, head);
  const parents = new Set(points.map((p) => p.base).filter((b): b is number => b !== null));

  // последняя точка линии в дне и в неделе
  const later = (a: P | undefined, b: P) => !a || b.at > a.at || (b.at === a.at && b.id > a.id);
  const lastDay = new Map<number, P>();
  const lastWeek = new Map<number, P>();
  for (const p of points) {
    if (!line.has(p.id)) continue;
    if (later(lastDay.get(dayOf(p.at)), p)) lastDay.set(dayOf(p.at), p);
    if (later(lastWeek.get(weekOf(p.at)), p)) lastWeek.set(weekOf(p.at), p);
  }

  // конец ветки и точка линии, от которой ветка ушла, — год от конца ветки
  const pin = new Map<number, number>();
  const hold = (id: number, end: number) => pin.set(id, Math.max(pin.get(id) ?? 0, end));
  for (const p of points) {
    if (p.id === head || parents.has(p.id)) continue;
    const end = p.at + YEAR;
    hold(p.id, end);
    const seen = new Set<number>();
    let c = p.base;
    while (c !== null && byId.has(c) && !line.has(c) && !seen.has(c)) {
      seen.add(c);
      c = byId.get(c)!.base;
    }
    if (c !== null && line.has(c)) hold(c, end);
  }

  const out = new Map<number, number | null>();
  for (const p of points) {
    if (p.id === head) {
      out.set(p.id, null);
      continue;
    }
    const d = dayOf(p.at);
    let end = dayStart(d + 2);
    if (lastDay.get(d) === p) end = Math.max(end, dayStart(d + 30));
    if (lastWeek.get(weekOf(p.at)) === p) end = Math.max(end, dayStart(d + 365));
    end = Math.max(end, pin.get(p.id) ?? 0);
    out.set(p.id, end);
  }
  return out;
}

/** Точки, которые уборка в миг now убирает. Сессия без новых точек год — все. */
export function gone(points: P[], head: number, now: number): number[] {
  const h = points.find((p) => p.id === head);
  if (!h || now - h.at >= YEAR) return points.map((p) => p.id);
  const until = untilOf(points, head);
  return points.filter((p) => {
    const u = until.get(p.id);
    return u !== null && u !== undefined && u <= now;
  }).map((p) => p.id);
}
