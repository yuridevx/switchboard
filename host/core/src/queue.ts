// Очередь ввода сессии. Живёт в ядре: при resume новый query() берёт ту же очередь.
// Поток для query() не кончается никогда: конец потока SDK понял бы как конец ввода и закрыл процесс.
// Поток прежнего query() после смены засыпает навсегда и ничего не забирает.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class InputQueue {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private generation = 0;

  push(m: SDKUserMessage): void {
    this.items.push(m);
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Поток для нового query(); прежний поток больше не отдаёт ничего. */
  stream(): AsyncIterable<SDKUserMessage> {
    const mine = ++this.generation;
    const q = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (q.generation !== mine) await new Promise<never>(() => {});
          const m = q.items.shift();
          if (m) yield m;
          else await new Promise<void>((r) => (q.wake = r));
        }
      },
    };
  }
}
