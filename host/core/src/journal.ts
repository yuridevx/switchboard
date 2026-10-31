// Журнал машины: строка JSON на запись в ~/.switchboard/journal/host-<дата UTC>.jsonl.
// Запись сразу, без буфера: упал Host — всё записанное уже на диске.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogRecord } from "../contract.ts";
import type { Clock } from "./clock.ts";

export type Journal = (who: string, rec: LogRecord) => void;

export function journal(dir: string, machine: string, clock: Clock): Journal {
  mkdirSync(dir, { recursive: true });
  return (who, rec) => {
    const t = new Date(clock.now()).toISOString();
    const line = { t, part: "host", machine, who, ...rec, kind: rec.kind ?? "note" };
    appendFileSync(join(dir, `host-${t.slice(0, 10)}.jsonl`), JSON.stringify(line) + "\n");
  };
}
