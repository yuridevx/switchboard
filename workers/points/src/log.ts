// Журнал Worker'а — Workers Logs: одна строка JSON в общем формате журналов. Ключей R2 и текста разговоров в журнале нет.
export function log(rec: { kind: "stop" | "refuse" | "note"; ev: string; word?: string; why?: string; [field: string]: unknown }): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), part: "points", ...rec }));
}
