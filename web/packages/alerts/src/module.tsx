// Снесено: экрана и уведомлений нет, пока модуль не написан заново. Типы — контракт модуля.
import type { App, AppModule } from "@switchboard/web-core";

/** Что модуль берёт у браузера; в тестах — подделка. */
export type BrowserPush = {
  sw?: {
    register(url: string): Promise<unknown>;
    ready: Promise<{ pushManager: { getSubscription(): Promise<{ toJSON(): unknown } | null>; subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<{ toJSON(): unknown }> } }>;
    addEventListener(t: "message", fn: (e: { data: unknown }) => void): void;
  };
  Notification?: { permission: string; requestPermission(): Promise<string> };
};

/** Состояние уведомлений устройства: off — браузер не умеет. */
export type AlertsState = "off" | "ask" | "working" | "on" | "denied" | "error";

export const createAlerts = (_browser?: BrowserPush) => (_app: App): AppModule => ({});
