// Отказ словом и журнал: Workers Logs, одна строка JSON в общем формате журналов.
export class Refusal extends Error {
  constructor(
    readonly word: string,
    readonly why: string,
    readonly journal: Record<string, unknown> = {},
  ) {
    super(`${word}: ${why}`);
  }
}

export type Line = { kind: "refuse" | "note" | "stop"; ev: string; word?: string; why?: string; [field: string]: unknown };

export function log(line: Line): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), part: "releases", ...line }));
}
