// Журнал машины: строка JSON на запись в journal/host-<дата>.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogRecord } from "../contract.ts";
import type { Clock } from "./clock.ts";

export class Journal {
  private readonly dir: string;
  private readonly machine: string;
  private readonly clock: Clock;

  constructor(dir: string, machine: string, clock: Clock) {
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.machine = machine;
    this.clock = clock;
  }

  write(who: string, record: LogRecord): void {
    const t = new Date(this.clock.now()).toISOString();
    appendFileSync(join(this.dir, `host-${t.slice(0, 10)}.jsonl`), JSON.stringify({ t, part: "host", machine: this.machine, who, kind: "note", ...record }) + "\n");
  }
}
