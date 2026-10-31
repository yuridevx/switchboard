// Журнал github — Workers Logs: одна строка JSON в общем формате журналов.
// Токенов и ключей в журнале нет; статус и текст GitHub — при github_failed.
export function log(rec: { kind: "stop" | "refuse" | "note"; ev: string; word?: string; why?: string; [field: string]: unknown }): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), part: "github", ...rec }));
}
