// Служебный обработчик пушей: работает без открытого окна приложения.
// Пуш — сохранить в раздел pushes (кадр больше нигде не хранится) и показать. Нажатие — открыть приложение; кнопка (Android) — ответ коротким соединением.
import { hostOf, withLimit } from "@switchboard/protocol";
import { link, type Frame, type Reply, type WsCtor } from "@switchboard/relay";
import type { Store } from "@switchboard/web-core";

/** Что показать: кнопки с кадром; tag — id вопроса, тот же tag заменяет уведомление. */
type Notify = { title?: string; body?: string; tag?: string; actions?: Array<{ title: string; frame?: Frame }> };
/** Пуш в разделе pushes; clicked — его уведомление нажали. */
export type StoredPush = { id: string; type: string; from?: string; notify?: Notify; at: number; clicked?: boolean };
/** Данные уведомления: пуш без времени и отметки. */
type Shown = { id: string; type: string; from?: string; notify: Notify };

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
  /** адрес relay из списка сборки: обещание — обработчик читает его при старте */
  relayUrl: string | Promise<string>;
  /** хранилище приложения: key и pushes */
  store: Store;
  /** сколько кнопок показывает браузер: Notification.maxActions (Chrome на Android — 2, Safari — 0) */
  maxActions: () => number;
  WebSocket?: WsCtor;
};

/** Предел короткого соединения: соединиться и получить ответ. */
const SEND_MS = 30_000;

const refusal = (error: string): Reply => ({ type: "reply", id: "", ok: false, error });

/** Кадр по короткому соединению с relay машины адресата: hello с пропуском, кадр, ответ, закрытие. Обрыв и отказ — без переподключений. */
async function sendOnce(o: SwOptions, frame: Frame): Promise<Reply> {
  const key = await o.store.get<string>("key");
  if (!key) return refusal("no_key");
  const machine = hostOf(frame);
  if (!machine) return refusal("bad_frame");
  const base = (await o.relayUrl).replace(/\/$/, "");
  let close = () => {};
  const answer = new Promise<Reply>((resolve) => {
    let settled = false;
    const conn = link({
      url: `${base}/m/${machine}`,
      key,
      WebSocket: o.WebSocket,
      onState(state, why) {
        if (settled || (state !== "open" && state !== "closed" && state !== "stopped")) return;
        settled = true;
        if (state === "open") void conn.request(frame).then(resolve);
        else resolve(refusal(why || "disconnected"));
      },
    });
    close = () => conn.close(1000, "done");
  });
  const r = await withLimit(answer, SEND_MS, () => refusal("timeout"));
  close();
  return r;
}

/** Поставить обработчики пушей на scope служебного обработчика. */
export function serviceWorker(scope: SwScope, o: SwOptions) {
  scope.addEventListener("install", (e) => e.waitUntil(scope.skipWaiting()));
  scope.addEventListener("activate", (e) => e.waitUntil(scope.clients.claim()));

  /** Тело пуша; не по форме — null. */
  function parse(data: { json(): unknown } | null): { type: string; from?: string; notify: Notify } | null {
    let raw: { type?: unknown; from?: unknown; notify?: Notify } | null;
    try {
      raw = (data?.json() ?? null) as typeof raw;
    } catch {
      return null;
    }
    if (typeof raw?.type !== "string") return null;
    return { type: raw.type, from: typeof raw.from === "string" ? raw.from : undefined, notify: raw.notify ?? {} };
  }

  async function onPush(p: { type: string; from?: string; notify: Notify }): Promise<void> {
    const id = crypto.randomUUID();
    await o.store.update<StoredPush[]>("pushes", (saved) => [...(saved ?? []), { id, ...p, at: Date.now() }]);
    const { title, body, tag, actions = [] } = p.notify;
    // кнопки — только если помещаются все и у каждой есть кадр; иначе нажатие откроет приложение
    const buttons = actions.length > 0 && actions.length <= o.maxActions() && actions.every((a) => a.frame);
    await scope.registration.showNotification(title ?? p.from ?? "Switchboard", {
      body,
      tag,
      data: { id, ...p } satisfies Shown,
      actions: buttons ? actions.map((a, i) => ({ action: String(i), title: a.title })) : [],
      icon: "icon-192.png",
    });
  }

  async function onButton(shown: Shown, frame: Frame): Promise<void> {
    const r = await sendOnce(o, frame);
    if (r.ok) return;
    console.error(`switchboard: ответ из уведомления не отправлен — ${r.error}`);
    await scope.registration.showNotification(`Ответ не отправлен: ${r.error}`, { body: shown.notify.body, tag: shown.notify.tag, data: shown });
  }

  async function onOpen(shown: Shown): Promise<void> {
    await o.store.update<StoredPush[]>("pushes", (saved) => (saved ?? []).map((p) => (p.id === shown.id ? { ...p, clicked: true } : p)));
    const [win] = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!win) return void (await scope.clients.openWindow(scope.registration.scope));
    win.postMessage("pushes");
    await win.focus();
  }

  scope.addEventListener("push", (e) => {
    const p = parse(e.data);
    if (p) e.waitUntil(onPush(p));
    else console.error("switchboard: пуш не по форме — нет type");
  });

  scope.addEventListener("notificationclick", (e) => {
    e.notification.close();
    const shown = e.notification.data as Shown;
    const frame = e.action !== "" ? shown.notify.actions?.[Number(e.action)]?.frame : undefined;
    e.waitUntil(frame ? onButton(shown, frame) : onOpen(shown));
  });
}
