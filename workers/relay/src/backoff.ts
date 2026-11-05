// Растущая пауза повторов: одна на соединение с объектом и на список машин у gate.

export type Backoff = {
  /** Пауза этой попытки; следующая — вдвое больше, не выше потолка. */
  next(): number;
  /** Удача: снова с первой паузы. */
  reset(): void;
};

export function backoff(first = 1_000, max = 60_000): Backoff {
  let pause = first;
  return {
    next() {
      const now = pause;
      pause = Math.min(pause * 2, max);
      return now;
    },
    reset() {
      pause = first;
    },
  };
}
