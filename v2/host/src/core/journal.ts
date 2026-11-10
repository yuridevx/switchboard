// Журнал машины: строки формы LogLine в host-<дата>.jsonl папки журнала — той же, куда пишут Keeper и держатели.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger, type Logger, type LogLine, type Sink } from "@sb/protocol";

/** Запись строк в файл дня. Время строки ставит logger; в тестах — часы стенда через now. */
export function fileSink(dir: string, part = "host", now?: () => number): Sink {
  mkdirSync(dir, { recursive: true });
  return (line: LogLine) => {
    const l = now ? { ...line, t: now() } : line;
    appendFileSync(join(dir, `${part}-${new Date(l.t).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(l) + "\n");
  };
}

export const hostLogger = (dir: string, machine: string, fleet: string, now?: () => number): Logger => logger("host", fileSink(dir, "host", now), { machine, fleet });
