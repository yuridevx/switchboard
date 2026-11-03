// web-alerts — уведомления: полоса «Включить уведомления» (push.key → подписка браузера → push.subscribe)
// и пуши, сохранённые обработчиком, — ядру при старте и возвращении на экран (кадр уходит владельцу по type).
// Ключ VAPID и подписка — у Worker push; машинам приложение подписку не шлёт и у себя её не хранит.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./alerts.css";
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

/** Новый модуль; browser — API пушей браузера (по умолчанию глобальные). */
export function createAlerts(browser?: BrowserPush): AppModule {
  let app: App;
  let state: AlertsState = "off";
  let error = "";
  const env = (): BrowserPush =>
    browser ?? {
      sw: (globalThis.navigator as Navigator | undefined)?.serviceWorker as unknown as BrowserPush["sw"],
      Notification: (globalThis as { Notification?: BrowserPush["Notification"] }).Notification,
    };
  const supported = () => {
    const e = env();
    return !!e.sw && !!e.Notification && (browser !== undefined || "PushManager" in globalThis);
  };

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
    if (!supported()) return void (state = "off");
    const e = env();
    if (e.Notification!.permission === "denied") state = "denied";
    else if (e.Notification!.permission !== "granted") state = "ask";
    else {
      const reg = await e.sw!.ready;
      state = (await reg.pushManager.getSubscription()) ? "on" : "ask";
    }
    app.changed();
  }

  async function enable() {
    const e = env();
    state = "working";
    error = "";
    app.changed();
    // разрешение спрашивается только по нажатию
    const perm = await e.Notification!.requestPermission();
    if (perm !== "granted") {
      state = perm === "denied" ? "denied" : "ask";
      return app.changed();
    }
    const k = await app.request<{ key: string }>("push.key");
    if (!k.ok) return fail(k.error);
    const reg = await e.sw!.ready;
    let sub: { toJSON(): unknown };
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(k.result.key) });
    } catch (x) {
      return fail(x instanceof Error ? x.message : String(x));
    }
    const r = await app.request("push.subscribe", { sub: sub.toJSON() });
    if (!r.ok) return fail(r.error);
    state = "on";
    app.changed();
    app.toast("Уведомления включены: сессии достучатся, когда приложение закрыто.", "ok");
  }

  function fail(word: string) {
    console.error(`switchboard: уведомления не включены — ${word}`);
    state = "error";
    error = word;
    app.changed();
  }

  function Alerts() {
    const now = app.use(() => ({ state, error }));
    if (now.state === "off" || now.state === "on") return null;
    if (now.state === "denied") {
      return (
        <div className="al-card muted">
          <span>
            <b>Уведомления запрещены</b>
            <span>Разрешите их в настройках браузера для этого сайта.</span>
          </span>
        </div>
      );
    }
    return (
      <div className="al-card">
        <span>
          <b>Включить уведомления</b>
          <span>{now.state === "error" ? `Не вышло: ${now.error}` : "Сессии достучатся, когда приложение закрыто."}</span>
        </span>
        <button className="al-on" disabled={now.state === "working"} onClick={() => void enable()}>
          {now.state === "working" ? "…" : now.state === "error" ? "Ещё раз" : "Включить"}
        </button>
      </div>
    );
  }

  let listening = false;
  return {
    screens: { alerts: { place: "top", label: "Уведомления", view: Alerts } },
    // состояние уведомлений этого устройства — для «Настроек»: off (браузер не умеет), ask, working, on, denied, error
    marks: { "alerts.state": () => state },
    store: ["pushes"],
    css,
    async start(a) {
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
