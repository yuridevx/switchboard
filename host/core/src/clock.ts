// Часы ядра: время журнала и все пределы ядра идут по ним; на стенде их двигает тест.
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Предел по часам ядра: не успела за ms — ответ late. Саму работу не прерывает. */
export function limit<T>(clock: Clock, work: T | Promise<T>, ms: number, late: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => resolve(late()), ms);
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => clock.clearTimeout(timer));
  });
}
