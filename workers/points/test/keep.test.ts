import { describe, expect, it } from "vitest";
import { DAY, gone, lineOf, untilOf, weekOf, YEAR } from "../src/keep.ts";

const D = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);

describe("правило хранения", () => {
  it("неделя — с понедельника: воскресенье и следующий понедельник в разных неделях", () => {
    // 2026-11-01 — воскресенье, 2026-11-02 — понедельник
    expect(weekOf(D(2026, 10, 26, 1))).toBe(weekOf(D(2026, 11, 1, 23)));
    expect(weekOf(D(2026, 11, 1, 23))).not.toBe(weekOf(D(2026, 11, 2, 0)));
  });

  it("сроки: голова — null; не последняя в дне — до послезавтра; последняя в дне — 30 дней; последняя в неделе — год", () => {
    const pts = [
      { id: 1, at: D(2026, 10, 1, 10), base: null }, // четверг
      { id: 2, at: D(2026, 10, 1, 18), base: 1 },
      { id: 3, at: D(2026, 10, 2, 18), base: 2 }, // пятница — последняя в неделе
      { id: 4, at: D(2026, 10, 31, 9), base: 3 },
    ];
    const u = untilOf(pts, 4);
    expect(u.get(4)).toBeNull();
    expect(u.get(1)).toBe(D(2026, 10, 3));
    expect(u.get(2)).toBe(D(2026, 10, 31));
    expect(u.get(3)).toBe(D(2026, 10, 2) + 365 * DAY);
  });

  it("ветка: конец и точка линии, от которой она ушла, — год от конца ветки", () => {
    const pts = [
      { id: 1, at: D(2026, 1, 5, 10), base: null },
      { id: 2, at: D(2026, 1, 5, 11), base: 1 },
      { id: 3, at: D(2026, 1, 5, 12), base: 2 }, // ветка: 3 → 4
      { id: 4, at: D(2026, 1, 5, 13), base: 3 },
      { id: 5, at: D(2026, 1, 5, 14), base: 2 }, // линия идёт от 2
      { id: 6, at: D(2026, 6, 1, 9), base: 5 },
    ];
    expect([...lineOf(pts, 6)].sort()).toEqual([1, 2, 5, 6]);
    const u = untilOf(pts, 6);
    expect(u.get(4)).toBe(D(2026, 1, 5, 13) + YEAR);
    expect(u.get(2)).toBe(D(2026, 1, 5, 13) + YEAR);
    expect(u.get(3)).toBe(D(2026, 1, 7));
  });

  it("сессия без новых точек год — уходит целиком, голова тоже", () => {
    const pts = [
      { id: 1, at: D(2025, 1, 1), base: null },
      { id: 2, at: D(2025, 1, 2), base: 1 },
    ];
    expect(gone(pts, 2, D(2025, 1, 2) + YEAR - 1)).toEqual([1]);
    expect(gone(pts, 2, D(2025, 1, 2) + YEAR)).toEqual([1, 2]);
  });
});
