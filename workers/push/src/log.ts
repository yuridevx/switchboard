// Журнал Worker'а — Workers Logs, строка JSON в общем формате. Текста уведомлений и ключей подписок здесь не бывает.
export type Line = { kind: "stop" | "refuse" | "note"; ev: string; word?: string; why?: string; [field: string]: unknown };

export const log = (line: Line): void => console.log(JSON.stringify({ t: new Date().toISOString(), part: "push", ...line }));
