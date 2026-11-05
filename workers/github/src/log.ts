// Журнал github — Workers Logs: одна строка JSON в общем формате журналов. Токенов и ключей здесь нет.
export type Line = { kind: "refuse" | "note"; ev: string; word?: string; why?: string; [field: string]: unknown };

export function log(line: Line): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), part: "github", ...line }));
}
