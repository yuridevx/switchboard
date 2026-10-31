// Очередь ввода сессии. Живёт в ядре: при resume новый query() берёт ту же очередь.
// Поток для query() не кончается никогда: конец потока SDK понял бы как конец ввода и закрыл процесс.
// Поток прежнего query() после смены засыпает навсегда и ничего не забирает.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class InputQueue {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private gen = 0;

  push(m: SDKUserMessage): void {
    this.items.push(m);
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  get length(): number {
    return this.items.length;
  }

  /** Поток для нового query(); прежний поток больше не отдаёт ничего. */
  stream(): AsyncIterable<SDKUserMessage> {
    const my = ++this.gen;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (self.gen !== my) await new Promise<never>(() => {});
          const m = self.items.shift();
          if (m) {
            yield m;
            continue;
          }
          await new Promise<void>((r) => {
            self.wake = r;
          });
        }
      },
    };
  }
}
