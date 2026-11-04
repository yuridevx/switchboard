// Состояние уведомлений устройства и путь включения: разрешение → push.key → подписка браузера → push.subscribe.
// Пуши, сохранённые обработчиком, — ядру при старте и возвращении на экран (кадр уходит владельцу по type).
import { withLimit } from "@switchboard/protocol";
import type { App } from "@switchboard/web-core";
import { createStore, useModule } from "@switchboard/web-ui";
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
/** Предел разрешения и подписки браузера: ни ответа, ни отказа — кнопка снова доступна. */
export const ASK_MS = 120_000;

export type AlertsStore = ReturnType<typeof createAlertsStore>;
/** Стор модуля в экранах. */
export const useAlerts = (): AlertsStore => useModule<AlertsStore>();

/** browser — API пушей браузера (по умолчанию глобальные). */
export function createAlertsStore(app: App, browser?: BrowserPush) {
  const store = createStore<{ state: AlertsState; error: string }>({ state: "off", error: "" }, () => app.changed());

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
  const ready = (e: BrowserPush) => withLimit(e.sw!.ready, READY_MS, () => null);

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

  async function collect() {
    await takePushes();
    void check();
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
      const perm = await withLimit(e.Notification!.requestPermission(), ASK_MS, () => "default" as const);
      if (perm !== "granted") return setState(perm === "denied" ? "denied" : "ask");
      const k = await app.read<{ key: string }>("push.key");
      if (!k.ok) return fail(k.error);
      const reg = await ready(e);
      if (!reg) return fail("обработчик пушей не поднялся");
      let sub: { toJSON(): unknown };
      try {
        sub = await withLimit(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(k.result.key) }), ASK_MS, () => {
          throw new Error("браузер не подписал за предел");
        });
      } catch (x) {
        return fail(x instanceof Error ? x.message : String(x));
      }
      const r = await app.request("push.subscribe", { sub: sub.toJSON() });
      if (!r.ok) return fail(r.error);
      setState("on");
      app.toast("Уведомления включены: сессии достучатся, когда приложение закрыто.", "ok");
    },
    async start() {
      const e = env();
      if (e.sw) {
        // обработчик открыл уже открытое окно — пуши забрать сразу
        e.sw.addEventListener("message", (m) => {
          if (m.data === "pushes") void takePushes();
        });
        e.sw.register("sw.js").catch((x: unknown) => console.error("switchboard: обработчик пушей не зарегистрирован", x));
      }
      await collect();
    },
    /** Страница вернулась на экран: пуши, пришедшие без неё. */
    show: collect,
  };
}
