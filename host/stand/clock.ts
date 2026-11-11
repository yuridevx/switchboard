// Поддельные часы ядра: время журнала и таймеры ядра идут только по advance().
import type { Clock } from "../src/core/clock.ts";

export class FakeClock implements Clock {
  private t: number;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;

  constructor(start = Date.UTC(2026, 9, 30, 14, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }

  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }

  /** Сдвинуть время и выполнить таймеры, чей срок настал, по порядку. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}
