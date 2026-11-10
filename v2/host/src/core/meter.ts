// Счётчики Host за окно: сколько раз что случилось и сколько длилось. Модули пишут сюда, модуль машины раз в минуту отдаёт окно службе наблюдения.

export type Timing = { n: number; p50: number; p95: number };
export type Window = { counts: Record<string, number>; times: Record<string, Timing> };

export interface Meter {
  /** случилось n раз */
  count(name: string, n?: number): void;
  /** длилось ms */
  time(name: string, ms: number): void;
  /** отдать окно и начать новое */
  take(): Window;
}

/** Предел замеров одного имени за окно: дальше окно сохраняет счёт, а новые длительности не копит. */
const KEEP = 5000;

const at = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;

export function meter(): Meter {
  let counts = new Map<string, number>();
  let times = new Map<string, { n: number; ms: number[] }>();
  return {
    count(name, n = 1) {
      counts.set(name, (counts.get(name) ?? 0) + n);
    },
    time(name, ms) {
      const t = times.get(name) ?? { n: 0, ms: [] };
      t.n++;
      if (t.ms.length < KEEP) t.ms.push(ms);
      times.set(name, t);
    },
    take() {
      const out: Window = { counts: Object.fromEntries(counts), times: {} };
      for (const [name, t] of times) {
        const sorted = [...t.ms].sort((a, b) => a - b);
        out.times[name] = { n: t.n, p50: at(sorted, 0.5), p95: at(sorted, 0.95) };
      }
      counts = new Map();
      times = new Map();
      return out;
    },
  };
}
