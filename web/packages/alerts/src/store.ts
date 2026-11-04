// Уведомления устройства: состояние, путь включения и забор пушей, которые сохранил обработчик.
// Истина о подписке — у браузера и Worker'а push; здесь её нет.
import { withLimit } from "@switchboard/protocol";
import type { App } from "@switchboard/web-core";
import { createStore, useModule } from "@switchboard/web-ui";
import type { StoredPush } from "./sw.ts";

type PushManagerLike = { getSubscription(): Promise<{ toJSON(): unknown } | null>; subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<{ toJSON(): unknown }> };

/** Что модуль берёт у браузера; в тестах — подделка. */
export type BrowserPush = {
  sw?: {
    register(url: string): Promise<unknown>;
    ready: Promise<{ pushManager: PushManagerLike }>;
    addEventListener(t: "message", fn: (e: { data: unknown }) => void): void;
  };
  Notification?: { permission: string; requestPermission(): Promise<string> };
};

/** Состояние уведомлений устройства: off — браузер не умеет. */
export type AlertsState = "off" | "ask" | "working" | "on" | "denied" | "error";

/** Предел ожидания обработчика пушей. */
const READY_MS = 10_000;
/** Предел разрешения и подписки: человек думает, браузер может промолчать. */
const ASK_MS = 120_000;

const keyBytes = (b64u: string) => Uint8Array.from(atob(b64u.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64u.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

const globalPush = (): BrowserPush => ({
  sw: globalThis.navigator?.serviceWorker as unknown as BrowserPush["sw"],
  Notification: (globalThis as { Notification?: BrowserPush["Notification"] }).Notification,
});

export type AlertsStore = ReturnType<typeof createAlertsStore>;
export const useAlerts = (): AlertsStore => useModule<AlertsStore>();

export function createAlertsStore(app: App, browser?: BrowserPush) {
  const { sw, Notification: permission } = browser ?? globalPush();
  // обработчик ставится и без пушей: подделка стенда PushManager не объявляет
  const supported = !!sw && !!permission && (browser !== undefined || "PushManager" in globalThis);
  const s =createStore<{ state: AlertsState; error: string }>({ state: "off", error: "" }, () => app.changed());
  const to = (state: AlertsState, error = "") =>
    s.set((d) => {
      d.state = state;
      d.error = error;
    });
  const handler = () => withLimit(sw!.ready, READY_MS, () => null);

  /** Состояние по браузеру: что разрешено и есть ли подписка. */
  async function look(): Promise<void> {
    if (!supported) return to("off");
    if (permission!.permission === "denied") return to("denied");
    if (permission!.permission !== "granted") return to("ask");
    const reg = await handler();
    to(reg && (await reg.pushManager.getSubscription()) ? "on" : "ask");
  }

  /** Пуши из раздела pushes — ядру: владелец кадра рисует его как пришедший по связи; нажатый открывает его экран. */
  async function takePushes(): Promise<void> {
    let taken: StoredPush[] = [];
    await app.store<StoredPush[]>("pushes").update((old) => {
      taken = old ?? [];
      return [];
    });
    for (const p of taken) app.deliver({ type: p.type, from: p.from, notify: p.notify }, { open: !!p.clicked });
  }

  async function collect(): Promise<void> {
    await takePushes();
    void look();
  }

  function fail(word: string): void {
    console.error(`switchboard: уведомления не включены — ${word}`);
    to("error", word);
  }

  /** Подписка браузера с пределом: отказ браузера и молчание — слово. */
  async function subscribe(reg: { pushManager: PushManagerLike }, key: string): Promise<{ toJSON(): unknown } | string> {
    try {
      const silent = () => {
        throw new Error("браузер не подписал за предел");
      };
      return await withLimit(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }), ASK_MS, silent);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async function enable(): Promise<void> {
    to("working");
    // разрешение спрашивается только по нажатию
    const answer = await withLimit(permission!.requestPermission(), ASK_MS, () => "default");
    if (answer !== "granted") return to(answer === "denied" ? "denied" : "ask");
    const key = await app.read<{ key: string }>("push.key");
    if (!key.ok) return fail(key.error);
    const reg = await handler();
    if (!reg) return fail("обработчик пушей не поднялся");
    const sub = await subscribe(reg, key.result.key);
    if (typeof sub === "string") return fail(sub);
    const r = await app.request("push.subscribe", { sub: sub.toJSON() });
    if (!r.ok) return fail(r.error);
    to("on");
    app.toast("Уведомления включены: сессии достучатся, когда приложение закрыто.", "ok");
  }

  async function start(): Promise<void> {
    if (sw) {
      // обработчик открыл уже открытое окно — пуши забрать сразу
      sw.addEventListener("message", (m) => {
        if (m.data === "pushes") void takePushes();
      });
      sw.register("sw.js").catch((e: unknown) => console.error("switchboard: обработчик пушей не зарегистрирован", e));
    }
    await collect();
  }

  return { state: () => s.get().state, error: () => s.get().error, enable, start, show: collect };
}
