// Уведомления устройства: полоса «Включить уведомления», метка alerts.state, пуши из раздела pushes — их владельцам.
import type { AppPart } from "@switchboard/web-core";
import { withLimit, within } from "@switchboard/protocol";
import css from "./alerts.css";

/** Пределы: обработчик поднимается; человек отвечает на разрешение и браузер подписывает. */
const READY_MS = 10_000;
const ASK_MS = 120_000;

export type AlertsState = "off" | "ask" | "working" | "on" | "denied" | "error";

type Subscription = { toJSON(): unknown };

/** API пушей браузера, которыми пользуется модуль: на стенде — подделка. */
export type BrowserPush = {
  Notification?: { permission: string; requestPermission(): Promise<string> };
  sw?: {
    register(url: string): Promise<unknown>;
    ready: Promise<{
      pushManager: {
        getSubscription(): Promise<Subscription | null>;
        subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<Subscription>;
      };
    }>;
    addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  };
};

/** Пуш в разделе pushes: его пишет обработчик, забирает страница. */
type Saved = { id: string; type: string; from?: string; notify: unknown; at: number; clicked?: boolean };

/** API страницы: без PushManager пуша нет, но обработчик пушей всё равно ставится. */
function pageBrowser(): BrowserPush {
  const g = globalThis as { navigator?: { serviceWorker?: BrowserPush["sw"] }; Notification?: BrowserPush["Notification"] };
  return { sw: g.navigator?.serviceWorker, Notification: "PushManager" in globalThis ? g.Notification : undefined };
}

const bytesOf = (b64u: string) => Uint8Array.from(atob(b64u.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64u.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const wordOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const createAlerts =
  (browser?: BrowserPush): AppPart["module"] =>
  (app) => {
    const b = browser ?? pageBrowser();
    let state: AlertsState = "off";
    let word = "";
    /** адрес подписки браузера, строку которой флот ещё не подтвердил: спрашиваем, когда связь открыта */
    let unverified: string | null = null;
    const set = (s: AlertsState, w = "") => {
      state = s;
      word = w;
      app.changed();
    };

    /** Пуши, пришедшие без страницы, — владельцам кадров; нажатый открывает свой экран. */
    async function take() {
      let saved: Saved[] = [];
      await app.store<Saved[]>("pushes").update((old) => ((saved = old ?? []), []));
      for (const p of saved) app.deliver({ type: p.type, from: p.from, notify: p.notify }, { open: !!p.clicked });
    }

    /** Строка подписки во флоте: нет — полоса, подписать заново. */
    async function verify(endpoint: string) {
      const r = await app.request<{ subscribed: boolean }>("push.subscribed", { endpoint });
      if (!r.ok) console.error(`switchboard: подписка во флоте не проверена — ${r.error}`);
      else if (!r.result.subscribed) set("ask");
    }

    async function check() {
      const { Notification: n, sw } = b;
      if (!n || !sw) return set("off");
      if (n.permission === "denied") return set("denied");
      if (n.permission !== "granted") return set("ask");
      const sub = await withLimit(
        sw.ready.then((r) => r.pushManager.getSubscription()),
        READY_MS,
        () => null,
      );
      if (!sub) return set("ask");
      set("on");
      unverified = (sub.toJSON() as { endpoint: string }).endpoint;
    }

    /** Разрешение по нажатию → ключ push → подписка браузера этим ключом → строка во флоте. */
    async function enable() {
      const { Notification: n, sw } = b;
      if (!n || !sw) return;
      set("working");
      try {
        const answer = await withLimit(n.requestPermission(), ASK_MS, () => "default");
        if (answer === "denied") return set("denied");
        if (answer !== "granted") return set("ask");
        const key = await app.request<{ key: string }>("push.key");
        if (!key.ok) throw new Error(key.error);
        const reg = await within(sw.ready, "обработчик пушей не поднялся", READY_MS);
        const sub = await within(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesOf(key.result.key) }), "браузер не подписал за предел", ASK_MS);
        const r = await app.request("push.subscribe", { sub: sub.toJSON() });
        if (!r.ok) throw new Error(r.error);
        set("on");
        app.toast("Уведомления включены: сессии достучатся, когда приложение закрыто.", "ok");
      } catch (e) {
        console.error(`switchboard: уведомления не включены — ${wordOf(e)}`);
        set("error", wordOf(e));
      }
    }

    function Bar() {
      const [s, w] = app.use(() => [state, word]);
      if (s === "denied")
        return (
          <div className="al-card muted">
            <span>
              <b>Уведомления запрещены</b>
              <span>Разрешите их в настройках браузера для этого сайта.</span>
            </span>
          </div>
        );
      if (s !== "ask" && s !== "working" && s !== "error") return null;
      return (
        <div className="al-card">
          <span>
            <b>Включить уведомления</b>
            {s === "error" ? <span>Не вышло: {w}</span> : null}
          </span>
          <button className="al-on" disabled={s === "working"} onClick={() => void enable()}>
            {s === "working" ? "…" : s === "error" ? "Ещё раз" : "Включить"}
          </button>
        </div>
      );
    }

    return {
      css,
      screens: { alerts: { place: "top", label: "Уведомления", view: Bar } },
      marks: { "alerts.state": () => state },
      store: ["pushes"],
      on: {
        show: take,
        link(s) {
          if (s !== "open" || !unverified) return;
          void verify(unverified);
          unverified = null;
        },
      },
      async start() {
        const { sw } = b;
        if (sw) {
          sw.register("sw.js").catch((e) => console.error("switchboard: обработчик пушей не зарегистрирован", e));
          sw.addEventListener("message", (e) => void (e.data === "pushes" && take()));
        }
        await take();
        await check();
      },
    };
  };
