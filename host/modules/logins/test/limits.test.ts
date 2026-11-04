// Правила лимитов: порог окна, годность аккаунта, очередь запаса. Чистые функции над записью аккаунта.
import { describe, expect, it } from "vitest";
import { nextUp, over, shown, stale, usableAt } from "../src/limits.ts";
import type { Account } from "../src/limits.ts";

const NOW = 1000;
const acc = (limits: Record<string, { utilization: number; resetsAt: number; at?: number }>, login: Account["login"] = "ok"): Account => ({ login, limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, { at: NOW, src: "event", ...v }])) });

describe("лимиты", () => {
  it.each([
    ["пять часов 94 % — годен", { five_hour: { utilization: 0.94, resetsAt: NOW + 9 } }, false],
    ["пять часов 95 % — у порога", { five_hour: { utilization: 0.95, resetsAt: NOW + 9 } }, true],
    ["неделя 97 % — годен", { seven_day: { utilization: 0.97, resetsAt: NOW + 9 } }, false],
    ["неделя 98 % — у порога", { seven_day: { utilization: 0.98, resetsAt: NOW + 9 } }, true],
    ["сброс прошёл — годен", { five_hour: { utilization: 1, resetsAt: NOW } }, false],
    ["сброс неизвестен — у порога", { five_hour: { utilization: 1, resetsAt: 0 } }, true],
  ])("%s", (_n, limits, want) => {
    expect(over(acc(limits), NOW)).toBe(want);
  });

  it("аккаунт снова годен после самого позднего сброса окон у порога", () => {
    expect(usableAt(acc({ five_hour: { utilization: 1, resetsAt: NOW + 5 }, seven_day: { utilization: 1, resetsAt: NOW + 50 }, other: { utilization: 0.1, resetsAt: NOW + 500 } }), NOW)).toBe(NOW + 50);
    expect(usableAt(acc({}), NOW)).toBe(0);
  });

  it("устарело, если самое свежее окно старше предела; окон нет — устарело", () => {
    expect(stale(acc({ five_hour: { utilization: 0, resetsAt: 0, at: NOW - 121 } }), 120, NOW)).toBe(true);
    expect(stale(acc({ five_hour: { utilization: 0, resetsAt: 0, at: NOW - 120 } }), 120, NOW)).toBe(false);
    expect(stale(acc({}), 120, NOW)).toBe(true);
  });

  it("наружу: окно, чей сброс прошёл, — 0 %, остальные как есть", () => {
    const a = shown(acc({ five_hour: { utilization: 0.9, resetsAt: NOW }, seven_day: { utilization: 0.6, resetsAt: NOW + 1 } }), NOW);
    expect([a.limits.five_hour.utilization, a.limits.seven_day.utilization]).toEqual([0, 0.6]);
  });

  it("следующий в запасе: по порядку, вошёл, ниже порога, не исключённый", () => {
    const all = { a: acc({}), b: acc({}, "none"), c: acc({ five_hour: { utilization: 1, resetsAt: NOW + 9 } }), d: acc({}) };
    expect(nextUp(["a", "b", "c", "d", "ghost"], all, NOW, "a")).toBe("d");
    expect(nextUp(["b", "c"], all, NOW, null)).toBeNull();
  });
});
