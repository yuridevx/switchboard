// Стенд пушей: поддельные API браузера и scope служебного обработчика.
import type { BrowserPush, SwScope } from "../contract.ts";

/** Поддельные API пушей браузера. */
export function fakeBrowser(permission = "default") {
  const calls: string[] = [];
  let sub: { toJSON(): unknown } | null = null;
  const msg: Array<(e: { data: unknown }) => void> = [];
  const b: BrowserPush & { calls: string[]; post(d: unknown): void } = {
    calls,
    post: (d) => msg.forEach((f) => f({ data: d })),
    Notification: {
      permission,
      async requestPermission() {
        calls.push("requestPermission");
        this.permission = "granted";
        return "granted";
      },
    },
    sw: {
      async register(url) {
        calls.push(`register ${url}`);
      },
      ready: Promise.resolve({
        pushManager: {
          async getSubscription() {
            return sub;
          },
          async subscribe(o) {
            calls.push(`subscribe ${o.applicationServerKey.length}`);
            sub = { toJSON: () => ({ endpoint: "https://web.push.apple.com/QF3", keys: { p256dh: "BNc", auth: "tB4" } }) };
            return sub;
          },
        },
      }),
      addEventListener: (_t, fn) => msg.push(fn),
    },
  };
  return b;
}


/** Поддельный scope служебного обработчика. */
export function fakeScope() {
  const ls: Record<string, Array<(e: any) => void>> = {};
  const shown: Array<{ title: string; o: any }> = [];
  const opened: string[] = [];
  const focused: string[] = [];
  let wins: Array<{ focus(): Promise<unknown>; postMessage(m: unknown): void }> = [];
  const scope: SwScope & { fire(t: string, e: any): Promise<void>; shown: typeof shown; opened: string[]; focused: string[]; setWins(n: number): void } = {
    addEventListener: ((t: string, fn: (e: any) => void) => (ls[t] ??= []).push(fn)) as SwScope["addEventListener"],
    skipWaiting: async () => {},
    registration: {
      scope: "https://switchboard-phone.test/",
      async showNotification(title, o) {
        shown.push({ title, o });
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => wins,
      openWindow: async (u) => void opened.push(u),
    },
    async fire(t, e) {
      const waits: Promise<unknown>[] = [];
      for (const fn of ls[t] ?? []) fn({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    },
    shown,
    opened,
    focused,
    setWins(n) {
      wins = Array.from({ length: n }, () => ({ focus: async () => void focused.push("focus"), postMessage: (m: unknown) => focused.push(`post ${m}`) }));
    },
  };
  return scope;
}

