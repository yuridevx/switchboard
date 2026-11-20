// Часы ядра: время журнала, все пределы и такты. На стенде их двигает тест.
/** clearTimeout снимает и таймер, и такт. */
export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; setInterval(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Обещание или отказ late() за предел ms: таймер снимается, как только работа ответила. */
export function limited<T>(clock: Clock, p: Promise<T>, ms: number, late: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(late()), ms);
    p.then(resolve, reject).finally(() => clock.clearTimeout(timer));
  });
}

/** Обещание или late() за предел ms. Саму работу не прерывает: что прервать, знает вызывающий. */
export function within<T>(clock: Clock, p: Promise<T>, ms: number, late: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(() => resolve(late()), ms);
    p.then(resolve, reject).finally(() => clock.clearTimeout(timer));
  });
}
