// Журнал prefs — Workers Logs: одна строка JSON в общем формате журналов. Значений настроек в журнале нет — только слово, from и key.
export function log(rec: { kind: "refuse" | "note"; ev: string; word?: string; why?: string; [field: string]: unknown }): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), part: "prefs", ...rec }));
}
