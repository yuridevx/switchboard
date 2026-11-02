// Служебный обработчик пушей: работает без открытого окна приложения.
// push — показать notify и сохранить type, from и notify в раздел pushes (кадр больше нигде не хранится).
// Нажатие — открыть приложение (пуш уйдёт модулю-владельцу); кнопка (Android) — короткое wss:
// hello с ключом из хранилища, кадр кнопки, reply, close(1000).
import { link, type Frame, type Reply, type WsCtor } from "@switchboard/relay";
import { hostOf } from "@switchboard/protocol";
import type { Store } from "@switchboard/web-core";

/** То, что показать: заголовок, текст, кнопки с кадром; tag — id вопроса, тот же tag заменяет уведомление. */
export type Notify = { title?: string; body?: string; tag?: string; actions?: Array<{ title: string; frame?: Frame }> };
/** Пуш в разделе pushes: type, from и notify кадра; clicked — его уведомление нажали. */
export type StoredPush = { id: string; type: string; from?: string; notify?: Notify; at: number; clicked?: boolean };

type NotificationData = { id: string; type: string; from?: string; notify: Notify };

/** Минимум ServiceWorkerGlobalScope, которым пользуется обработчик (в тестах — подделка). */
export interface SwScope {
  addEventListener(t: "install", fn: (e: { waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(t: "activate", fn: (e: { waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(t: "push", fn: (e: { data: { json(): unknown } | null; waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(
    t: "notificationclick",
    fn: (e: { action: string; notification: { data: unknown; close(): void }; waitUntil(p: Promise<unknown>): void }) => void,
  ): void;
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
  /** адрес relay из сборки */
  relayUrl: string;
  /** хранилище приложения: key и pushes */
  store: Store;
  /** сколько кнопок показывает браузер: Notification.maxActions (Chrome на Android — 2, Safari — 0) */
  maxActions: () => number;
  WebSocket?: WsCtor;
};

/** Отправить кадр по короткому соединению с relay машины адресата: hello с пропуском, кадр, reply, close(1000). */
export async function sendOnce(o: Pick<SwOptions, "relayUrl" | "store" | "WebSocket">, frame: Frame): Promise<Reply> {
  const key = await o.store.get<string>("key");
  if (!key) return { type: "reply", id: "", ok: false, error: "no_key" };
  const machine = hostOf(frame);
  if (!machine) return { type: "reply", id: "", ok: false, error: "bad_frame" };
  return new Promise<Reply>((resolve) => {
    let done = false;
    const l = link({
      url: `${o.relayUrl.replace(/\/$/, "")}/m/${machine}`,
      key,
      WebSocket: o.WebSocket,
      onState(s, why) {
        if (done) return;
        if (s === "open") {
          done = true;
          void l.request(frame).then((r) => {
            l.close(1000, "done");
            resolve(r);
          });
        } else if (s === "closed" || s === "stopped") {
          // обрыв или отказ — без переподключений: ответ не ушёл, человек увидит это в уведомлении
          done = true;
          l.close(1000, "done");
          resolve({ type: "reply", id: "", ok: false, error: why || "disconnected" });
        }
      },
    });
  });
}

/** Поставить обработчики пушей на scope служебного обработчика. */
export function serviceWorker(scope: SwScope, o: SwOptions) {
  scope.addEventListener("install", (e) => e.waitUntil(scope.skipWaiting()));
  scope.addEventListener("activate", (e) => e.waitUntil(scope.clients.claim()));

  scope.addEventListener("push", (e) => {
    type Raw = { type?: unknown; from?: unknown; notify?: Notify } | null;
    let p: Raw;
    try {
      p = (e.data?.json() ?? null) as Raw;
    } catch {
      p = null;
    }
    if (!p || typeof p.type !== "string") {
      console.error("switchboard: пуш не по форме — нет type");
      return;
    }
    e.waitUntil(onPush({ type: p.type, from: typeof p.from === "string" ? p.from : undefined, notify: p.notify ?? {} }));
  });

  async function onPush(p: { type: string; from?: string; notify: Notify }) {
    const rec: StoredPush = { id: crypto.randomUUID(), type: p.type, from: p.from, notify: p.notify, at: Date.now() };
    await o.store.update<StoredPush[]>("pushes", (a) => [...(a ?? []), rec]);
    const n = p.notify;
    const acts = n.actions ?? [];
    // кнопки — только если все варианты помещаются и у каждой есть кадр; иначе нажатие откроет приложение
    const buttons = acts.length > 0 && acts.length <= o.maxActions() && acts.every((a) => a.frame);
    const data: NotificationData = { id: rec.id, type: p.type, from: p.from, notify: n };
    await scope.registration.showNotification(n.title ?? p.from ?? "Switchboard", {
      body: n.body,
      tag: n.tag,
      data,
      actions: buttons ? acts.map((a, i) => ({ action: String(i), title: a.title })) : [],
      icon: "icon-192.png",
    });
  }

  scope.addEventListener("notificationclick", (e) => {
    e.notification.close();
    const d = e.notification.data as NotificationData;
    const frame = e.action !== "" ? d.notify.actions?.[Number(e.action)]?.frame : undefined;
    e.waitUntil(frame ? onButton(d, frame) : onOpen(d));
  });

  async function onButton(d: NotificationData, frame: Frame) {
    const r = await sendOnce(o, frame);
    if (r.ok) return;
    console.error(`switchboard: ответ из уведомления не отправлен — ${r.error}`);
    await scope.registration.showNotification(`Ответ не отправлен: ${r.error}`, { body: d.notify.body, tag: d.notify.tag, data: d });
  }

  async function onOpen(d: NotificationData) {
    await o.store.update<StoredPush[]>("pushes", (a) => (a ?? []).map((p) => (p.id === d.id ? { ...p, clicked: true } : p)));
    const wins = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.length) {
      wins[0].postMessage("pushes");
      await wins[0].focus();
    } else await scope.clients.openWindow(scope.registration.scope);
  }
}
