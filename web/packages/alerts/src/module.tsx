// Уведомления устройства: полоса над экранами, подписка браузера, пуши из раздела pushes — владельцам кадров.
import { withLimit, within } from "@switchboard/protocol";
import type { App } from "@switchboard/web-ui";
import css from "./alerts.css";

export type AlertsState = "off" | "ask" | "working" | "on" | "denied" | "error";

/** API браузера, которыми пользуется модуль; тесты подставляют подделку. */
export type BrowserPush = {
  Notification?: { permission: string; requestPermission(): Promise<string> };
  sw?: {
    register(url: string): Promise<unknown>;
    ready: Promise<{
      pushManager: {
        getSubscription(): Promise<{ toJSON(): unknown } | null>;
        subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<{ toJSON(): unknown }>;
      };
    }>;
    addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  };
};

/** Браузер молчит на разрешение или подписку; обработчик не поднялся. */
const ASK_MS = 120_000;
const READY_MS = 10_000;

const browserApis = (): BrowserPush => ({
  // без PushManager подписаться нельзя, а уже пришедшие пуши забрать надо
  Notification: "PushManager" in globalThis ? (Notification as unknown as BrowserPush["Notification"]) : undefined,
  sw: navigator.serviceWorker as unknown as BrowserPush["sw"],
});

const keyBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const failed = (r: { ok: true } | { ok: false; error: string }) => {
  if (!r.ok) throw new Error(r.error);
};

type Saved = { type: string; from?: string; notify?: unknown; clicked?: boolean };

export const createAlerts = (given?: BrowserPush) => (app: App) => {
  const { Notification: permission, sw } = given ?? browserApis();
  let ui: { state: AlertsState; word?: string } = { state: "off" };
  const show = (next: typeof ui) => {
    ui = next;
    app.changed();
  };
  const ready = () => within(sw!.ready, "обработчик пушей не поднялся", READY_MS);

  /** Пуши, сохранённые обработчиком: раздел пуст, кадры у владельцев; нажатый открывает свой экран. */
  async function takePushes(): Promise<void> {
    let taken: Saved[] = [];
    await app.store<Saved[]>("pushes").update((old) => {
      taken = old ?? [];
      return [];
    });
    for (const p of taken) app.deliver({ type: p.type, from: p.from, notify: p.notify }, { open: p.clicked === true });
  }

  async function firstState(): Promise<AlertsState> {
    if (!permission) return "off";
    if (permission.permission === "denied") return "denied";
    if (permission.permission !== "granted") return "ask";
    try {
      return (await (await ready()).pushManager.getSubscription()) ? "on" : "ask";
    } catch {
      return "ask";
    }
  }

  /** Браузер подписан, строки во флоте может не быть: пропуск отозван и выдан новый. Подписку заново даёт только нажатие. */
  async function checkHeld(): Promise<void> {
    if (ui.state !== "on") return;
    const sub = await (await ready()).pushManager.getSubscription();
    if (!sub) return;
    const held = await app.read<{ subscribed: boolean }>("push.subscribed", { endpoint: (sub.toJSON() as { endpoint: string }).endpoint });
    if (!held.ok) return console.error(`switchboard: подписка браузера не проверена — ${held.error}`);
    if (!held.result.subscribed && ui.state === "on") show({ state: "ask" });
  }

  async function enable(): Promise<void> {
    show({ state: "working" });
    try {
      const answer = await withLimit(permission!.requestPermission(), ASK_MS, () => "default");
      if (answer !== "granted") return show({ state: answer === "denied" ? "denied" : "ask" });
      const key = await app.request<{ key: string }>("push.key");
      if (!key.ok) throw new Error(key.error);
      const { pushManager } = await ready();
      const sub = await within(pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.result.key) }), "браузер не подписал за предел", ASK_MS);
      failed(await app.request("push.subscribe", { sub: sub.toJSON() }));
      show({ state: "on" });
      app.toast("Уведомления включены: сессии достучатся, когда приложение закрыто.");
    } catch (e) {
      const word = e instanceof Error ? e.message : String(e);
      console.error(`switchboard: уведомления не включены — ${word}`);
      show({ state: "error", word });
    }
  }

  function AlertsBar() {
    const { state, word } = app.use(() => ui);
    if (state === "off" || state === "on") return null;
    if (state === "denied") {
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
          {word ? <span>{`Не вышло: ${word}`}</span> : null}
        </span>
        <button type="button" className="al-on" disabled={state === "working"} onClick={() => void enable()}>
          {state === "working" ? "…" : state === "error" ? "Ещё раз" : "Включить"}
        </button>
      </div>
    );
  }

  return {
    css,
    store: ["pushes"],
    screens: { alerts: { place: "top", label: "Уведомления", view: AlertsBar } },
    marks: { "alerts.state": () => ui.state },
    on: {
      show: takePushes,
      link: (state: string) => {
        if (state === "open") void checkHeld();
      },
    },
    async start() {
      if (sw) {
        sw.register("sw.js").catch((e: unknown) => console.error("switchboard: обработчик пушей не зарегистрирован", e));
        sw.addEventListener("message", (e) => {
          if (e.data === "pushes") void takePushes();
        });
      }
      await takePushes();
      show({ state: await firstState() });
    },
  };
};
