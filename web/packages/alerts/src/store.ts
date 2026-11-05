// Снесено: заглушка на время сноса.
export type AlertsState = "off" | "ask" | "working" | "on" | "denied" | "error";
export type BrowserPush = { calls?: string[]; Notification?: unknown; sw?: unknown; [k: string]: unknown };
