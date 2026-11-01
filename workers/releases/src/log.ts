// Журнал releases — Workers Logs: одна строка JSON в общем формате журналов. Ссылок и ключей в журнале нет.
export function log(rec: { kind: "stop" | "refuse" | "note"; ev: string; word?: string; why?: string; [field: string]: unknown }): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), part: "releases", ...rec }));
}
