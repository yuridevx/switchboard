// снесено
import type { Store } from "@switchboard/web-core";

export type SwScope = {
  addEventListener(type: string, fn: (e: any) => void): void;
  skipWaiting(): Promise<void>;
  registration: { scope: string; showNotification(title: string, o: any): Promise<void> };
  clients: {
    claim(): Promise<void>;
    matchAll(o?: unknown): Promise<Array<{ focus(): Promise<unknown>; postMessage(m: unknown): void }>>;
    openWindow(url: string): Promise<unknown>;
  };
};

export function serviceWorker(_scope: SwScope, _o: { relayUrl: string | Promise<string>; store: Store; maxActions: () => number; WebSocket?: unknown }): void {
  throw new Error("снесено");
}
