// web-alerts — уведомления: полоса «Включить уведомления» (push.key → подписка браузера → push.subscribe)
// и пуши, сохранённые обработчиком, — ядру при старте и возвращении на экран (кадр уходит владельцу по type).
// Ключ VAPID и подписка — у Worker push; машинам приложение подписку не шлёт и у себя её не хранит.
import { h, type App, type AppModule, type ScreenHandle } from "@switchboard/web-core";
import { CSS } from "./css.ts";
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

type State = "off" | "ask" | "working" | "on" | "denied" | "error";

/** base64url → байты: открытый ключ VAPID для applicationServerKey. */
export function b64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Новый модуль; browser — API пушей браузера (по умолчанию глобальные). */
export function createAlerts(browser?: BrowserPush): AppModule {
  let app: App;
  let state: State = "off";
  let error = "";
  const handles = new Set<() => void>();
  const env = (): BrowserPush =>
    browser ?? {
      sw: (globalThis.navigator as Navigator | undefined)?.serviceWorker as unknown as BrowserPush["sw"],
      Notification: (globalThis as { Notification?: BrowserPush["Notification"] }).Notification,
    };
  const supported = () => {
    const e = env();
    return !!e.sw && !!e.Notification && (browser !== undefined || "PushManager" in globalThis);
  };
  const redraw = () => handles.forEach((f) => f());

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
    redraw();
  }

  async function enable() {
    const e = env();
    state = "working";
    error = "";
    redraw();
    // разрешение спрашивается только по нажатию
    const perm = await e.Notification!.requestPermission();
    if (perm !== "granted") {
      state = perm === "denied" ? "denied" : "ask";
      return redraw();
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
    redraw();
    app.toast("Уведомления включены: сессии достучатся, когда приложение закрыто.", "ok");
  }

  function fail(word: string) {
    console.error(`switchboard: уведомления не включены — ${word}`);
    state = "error";
    error = word;
    redraw();
  }

  function mountAlerts(el: HTMLElement): ScreenHandle {
    function draw() {
      el.textContent = "";
      if (state === "off" || state === "on") return;
      if (state === "denied") {
        el.append(h("div", { class: "al-card muted" }, h("span", null, h("b", null, "Уведомления запрещены"), h("span", null, "Разрешите их в настройках браузера для этого сайта."))));
        return;
      }
      el.append(
        h(
          "div",
          { class: "al-card" },
          h("span", null, h("b", null, "Включить уведомления"), h("span", null, state === "error" ? `Не вышло: ${error}` : "Сессии достучатся, когда приложение закрыто.")),
          h("button", { class: "al-on", disabled: state === "working", onclick: () => void enable() }, state === "working" ? "…" : state === "error" ? "Ещё раз" : "Включить"),
        ),
      );
    }
    handles.add(draw);
    draw();
    return { close: () => handles.delete(draw) };
  }

  let listening = false;
  return {
    screens: { alerts: { place: "top", label: "Уведомления", mount: mountAlerts } },
    store: ["pushes"],
    css: CSS,
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
