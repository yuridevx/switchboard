// Поддельные часы ядра: время журнала и таймеры ядра идут только по advance(). Новый таймер ядра — сигнал стенда.
import type { Clock } from "../src/core/clock.ts";
import { signal, until } from "./signal.ts";

export class FakeClock implements Clock {
  private t: number;
  /** every — такт: после срабатывания встаёт снова через столько же */
  private timers: Array<{ at: number; fn: () => void; id: number; every?: number }> = [];
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
    signal();
    return id;
  }

  /** Дождаться таймера на ms от нынешнего времени и дать его сроку настать. */
  async due(ms: number): Promise<void> {
    await until(() => this.pending().includes(ms), `таймер на ${ms} мс`);
    this.advance(ms);
  }

  /** Сколько осталось до каждого поставленного таймера. */
  pending(): number[] {
    return this.timers.map((x) => x.at - this.t);
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id, every: ms });
    signal();
    return id;
  }

  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }

  /** Сдвинуть время и выполнить таймеры, чей срок настал, по порядку. Таймер, поставленный в этом сдвиге, ждёт следующего:
   *  работа, которую начал сработавший таймер, на самом деле успевает раньше своего предела — здесь она идёт после сдвига. */
  advance(ms: number): void {
    const end = this.t + ms;
    const born = this.seq;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const at = this.timers.findIndex((x) => x.id <= born);
      const next = this.timers[at];
      if (!next || next.at > end) break;
      this.timers.splice(at, 1);
      this.t = next.at;
      if (next.every) this.timers.push({ ...next, at: next.at + next.every });
      next.fn();
    }
    this.t = end;
  }
}
