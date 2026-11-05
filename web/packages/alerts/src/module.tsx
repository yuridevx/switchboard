// снесено
import type { AppPart } from "@switchboard/web-core";

export type AlertsState = "off" | "ask" | "working" | "on" | "denied" | "error";

export type BrowserPush = {
  Notification?: { permission: string; requestPermission(): Promise<string> };
  sw?: {
    register(url: string): Promise<unknown>;
    ready: Promise<{
      pushManager: {
        getSubscription(): Promise<{ toJSON(): unknown } | null>;
        subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<{ toJSON(): unknown }>;
      };
    }>;
    addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  };
};

export const createAlerts =
  (_browser?: BrowserPush): AppPart["module"] =>
  () => ({
    start() {
      throw new Error("снесено");
    },
  });
