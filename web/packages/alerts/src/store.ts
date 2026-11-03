// Состояние уведомлений устройства и путь включения: разрешение → push.key → подписка браузера → push.subscribe.
// Пуши, сохранённые обработчиком, — ядру при старте и возвращении на экран (кадр уходит владельцу по type).
import type { App } from "@switchboard/web-core";
import { createStore } from "@switchboard/web-ui";
import type { StoredPush } from "./sw.ts";

/** Что модуль берёт у браузера; в тестах — подделка. */
export type BrowserPush = {
  /** navigator.serviceWorker */
  sw?: {
    register(url: string): Promise<unknown>;
    ready: Promise<{ pushManager: { getSubscription(): Promise<{ toJSON(): unknown } | null>; subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<{ toJSON(): unknown }> } }>;
    addEventListener(t: "message", fn: (e: { data: unknown }) => void): void;
  };
  /** глобальный Notification */
  Notification?: { permission: string; requestPermission(): Promise<string> };
};

/** Состояние уведомлений устройства: off — браузер не умеет. */
export type AlertsState = "off" | "ask" | "working" | "on" | "denied" | "error";

/** base64url → байты: открытый ключ VAPID для applicationServerKey. */
export function b64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Предел ожидания обработчика пушей: он не поднялся — отказ словом, а не вечное «включаю». */
export const READY_MS = 10_000;

export type AlertsStore = ReturnType<typeof createAlertsStore>;

/** browser — API пушей браузера (по умолчанию глобальные). */
export function createAlertsStore(browser?: BrowserPush) {
  let app: App;
  const store = createStore<{ state: AlertsState; error: string }>({ state: "off", error: "" }, () => app.changed());
  let listening = false;

  const env = (): BrowserPush =>
    browser ?? {
      sw: (globalThis.navigator as Navigator | undefined)?.serviceWorker as unknown as BrowserPush["sw"],
      Notification: (globalThis as { Notification?: BrowserPush["Notification"] }).Notification,
    };
  const supported = () => {
    const e = env();
    return !!e.sw && !!e.Notification && (browser !== undefined || "PushManager" in globalThis);
  };
  const setState = (state: AlertsState) => store.set((s) => void (s.state = state));

  /** Регистрация обработчика с пределом; не успел — null. */
  async function ready(e: BrowserPush) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), READY_MS)));
    try {
      return await Promise.race([e.sw!.ready, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Пуши из раздела pushes — ядру: владелец кадра рисует его как пришедший по связи. */
  async function takePushes() {
    let taken: StoredPush[] = [];
    await app.store<StoredPush[]>("pushes").update((old) => {
      taken = old ?? [];
      return [];
    });
    for (const p of taken) app.deliver({ type: p.type, from: p.from, notify: p.notify }, { open: !!p.clicked });
  }

  async function check() {
    if (!supported()) return setState("off");
    const e = env();
    if (e.Notification!.permission === "denied") setState("denied");
    else if (e.Notification!.permission !== "granted") setState("ask");
    else {
      const reg = await ready(e);
      setState(reg && (await reg.pushManager.getSubscription()) ? "on" : "ask");
    }
  }

  function fail(word: string) {
    console.error(`switchboard: уведомления не включены — ${word}`);
    store.set((s) => {
      s.state = "error";
      s.error = word;
    });
  }

  return {
    state: () => store.get().state,
    error: () => store.get().error,
    async enable() {
      const e = env();
      store.set((s) => {
        s.state = "working";
        s.error = "";
      });
      // разрешение спрашивается только по нажатию
      const perm = await e.Notification!.requestPermission();
      if (perm !== "granted") return setState(perm === "denied" ? "denied" : "ask");
      const k = await app.request<{ key: string }>("push.key");
      if (!k.ok) return fail(k.error);
      const reg = await ready(e);
      if (!reg) return fail("обработчик пушей не поднялся");
      let sub: { toJSON(): unknown };
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(k.result.key) });
      } catch (x) {
        return fail(x instanceof Error ? x.message : String(x));
      }
      const r = await app.request("push.subscribe", { sub: sub.toJSON() });
      if (!r.ok) return fail(r.error);
      setState("on");
      app.toast("Уведомления включены: сессии достучатся, когда приложение закрыто.", "ok");
    },
    async start(a: App) {
      app = a;
      const e = env();
      if (e.sw && !listening) {
        listening = true;
        // обработчик открыл уже открытое окно — пуши забрать сразу
        e.sw.addEventListener("message", (m) => {
          if (m.data === "pushes") void takePushes();
        });
        e.sw.register("sw.js").catch((x: unknown) => console.error("switchboard: обработчик пушей не зарегистрирован", x));
      }
      await takePushes();
      void check();
    },
  };
}
