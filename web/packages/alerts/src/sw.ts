// Снесено: обработчик ничего не ставит, пока не написан заново. Типы — контракт обработчика.
import type { WsCtor } from "@switchboard/relay";
import type { Store } from "@switchboard/web-core";

/** Минимум ServiceWorkerGlobalScope, которым пользуется обработчик (в тестах — подделка). */
export interface SwScope {
  addEventListener(t: "install", fn: (e: { waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(t: "activate", fn: (e: { waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(t: "push", fn: (e: { data: { json(): unknown } | null; waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(t: "notificationclick", fn: (e: { action: string; notification: { data: unknown; close(): void }; waitUntil(p: Promise<unknown>): void }) => void): void;
  skipWaiting(): Promise<void>;
  registration: {
    scope: string;
    showNotification(title: string, o: { body?: string; tag?: string; data?: unknown; actions?: Array<{ action: string; title: string }>; icon?: string }): Promise<void>;
  };
  clients: {
    claim(): Promise<void>;
    matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<Array<{ focus(): Promise<unknown>; postMessage(m: unknown): void }>>;
    openWindow(url: string): Promise<unknown>;
  };
}

export type SwOptions = {
  relayUrl: string | Promise<string>;
  store: Store;
  maxActions: () => number;
  WebSocket?: WsCtor;
};

export function serviceWorker(_scope: SwScope, _o: SwOptions) {}
