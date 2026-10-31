// Журнал push — Workers Logs: одна строка JSON в общем формате журналов.
// Текста уведомлений и ключей подписок в журнале нет.
export function log(rec: { kind: "stop" | "refuse" | "note"; ev: string; word?: string; why?: string; [field: string]: unknown }): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), part: "push", ...rec }));
}
