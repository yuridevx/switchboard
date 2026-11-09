// Журнал — одна форма строки во всех частях: Worker'ы, Host, страница. Строка — JSON; trace связывает строки одного запроса.

export type Level = "info" | "warn" | "error";

export type LogLine = {
  /** время, мс */
  t: number;
  level: Level;
  /** часть: platform, services, host, keeper, web */
  part: string;
  /** модуль внутри части */
  module?: string;
  msg: string;
  trace?: string;
  fleet?: string;
  machine?: string;
  /** запрос: имя, отправитель, адресат, длительность, исход */
  type?: string;
  from?: string;
  to?: string;
  ms?: number;
  ok?: boolean;
  word?: string;
  why?: string;
  [field: string]: unknown;
};

export type Sink = (line: LogLine) => void;

export interface Logger {
  info(msg: string, fields?: Partial<LogLine>): void;
  warn(msg: string, fields?: Partial<LogLine>): void;
  error(msg: string, fields?: Partial<LogLine>): void;
  /** тот же журнал с постоянными полями: модуль, trace, машина */
  with(fields: Partial<LogLine>): Logger;
}

const consoleSink: Sink = (l) => (l.level === "error" ? console.error : l.level === "warn" ? console.warn : console.log)(JSON.stringify(l));

export function logger(part: string, sink: Sink = consoleSink, base: Partial<LogLine> = {}): Logger {
  const emit = (level: Level, msg: string, fields?: Partial<LogLine>) => sink({ ...base, ...fields, t: Date.now(), level, part, msg });
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    with: (f) => logger(part, sink, { ...base, ...f }),
  };
}

/** Ошибку — в поля строки журнала. */
export function errFields(e: unknown): { why: string; stack?: string } {
  if (e instanceof Error) return { why: e.message, stack: e.stack };
  return { why: String(e) };
}

/** Секундомер отрезка пути. */
export function stopwatch(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}
