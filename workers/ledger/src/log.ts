// Журнал ledger (сбои самого ledger) — Workers Logs: одна строка JSON в общем формате журналов.
// Текста записей в журнале нет — только слово, from и ev.
export function log(rec: { kind: "stop" | "refuse" | "note"; ev: string; word?: string; why?: string; [field: string]: unknown }): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), part: "ledger", ...rec }));
}
