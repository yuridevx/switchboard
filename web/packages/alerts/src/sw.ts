// Обработчик пушей: показ и запись в раздел pushes; нажатие — окно приложения, кнопка — одно короткое соединение с relay машины.
import { hostOf, isReply, parseFrame, type Frame } from "@switchboard/protocol";
import { PROTO, type WsCtor } from "@switchboard/relay";
import type { Store } from "@switchboard/web-core";

/** Предел ответа на кнопку уведомления. */
const SEND_MS = 30_000;
const PUSHES = "pushes";

/** Scope служебного обработчика, которым он пользуется: на стенде — подделка. */
export type SwScope = {
  addEventListener(type: string, fn: (e: any) => void): void;
  skipWaiting(): Promise<void>;
  registration: { scope: string; showNotification(title: string, o: any): Promise<void> };
  clients: {
    claim(): Promise<void>;
    matchAll(o?: unknown): Promise<Array<{ focus(): Promise<unknown>; postMessage(m: unknown): void }>>;
    openWindow(url: string): Promise<unknown>;
  };
};

export type SwOptions = {
  /** адрес объектов relay: из списка сборки */
  relayUrl: string | Promise<string>;
  /** хранилище страницы: пропуск и раздел pushes */
  store: Store;
  /** сколько кнопок вмещает уведомление этого браузера */
  maxActions: () => number;
  WebSocket?: WsCtor;
};

type Notify = { title?: unknown; body?: unknown; tag?: unknown; actions?: Array<{ title: string; frame?: Frame }> };
type Pushed = { type: string; from?: unknown; notify?: Notify };
/** Данные уведомления: пуш в разделе и кадры его кнопок. */
type Shown = { id: string; body?: unknown; tag?: unknown; frames: Array<Frame | undefined> };

export function serviceWorker(scope: SwScope, o: SwOptions): void {
  const show = (title: string, data: Shown, actions: Array<{ action: string; title: string }> = []) =>
    scope.registration.showNotification(title, { body: data.body, tag: data.tag, icon: "icon-192.png", data, actions });

  async function onPush(data: { json(): unknown } | null) {
    let p: Pushed | undefined;
    try {
      p = data?.json() as Pushed | undefined;
    } catch {
      p = undefined;
    }
    if (typeof p?.type !== "string") return console.error("switchboard: пуш не по форме — нет type");
    const n = p.notify ?? {};
    const actions = Array.isArray(n.actions) ? n.actions : [];
    // кнопки — только все сразу: часть ответов человек бы не увидел
    const fits = actions.length > 0 && actions.length <= o.maxActions() && actions.every((a) => a.frame);
    const id = crypto.randomUUID();
    const title = typeof n.title === "string" ? n.title : typeof p.from === "string" ? p.from : "Switchboard";
    const { type, from, notify } = p;
    await Promise.all([
      show(title, { id, body: n.body, tag: n.tag, frames: actions.map((a) => a.frame) }, fits ? actions.map((a, i) => ({ action: String(i), title: a.title })) : []),
      o.store.update<unknown[]>(PUSHES, (old) => [...(old ?? []), { id, type, from, notify, at: Date.now() }]),
    ]);
  }

  /** Нажато уведомление: пуш помечен, открытое окно забирает раздел, иначе открывается новое. */
  async function open(id: string) {
    await o.store.update<Array<{ id: string }>>(PUSHES, (old) => (old ?? []).map((p) => (p.id === id ? { ...p, clicked: true } : p)));
    const [win] = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!win) return void (await scope.clients.openWindow(scope.registration.scope));
    win.postMessage(PUSHES);
    await win.focus();
  }

  /** Кадр кнопки в relay машины адресата: hello, кадр, reply. Итог — слово отказа или null. */
  function send(url: string, key: string, frame: Frame): Promise<string | null> {
    const WS = o.WebSocket ?? (globalThis as unknown as { WebSocket: WsCtor }).WebSocket;
    const id = crypto.randomUUID();
    return new Promise((done) => {
      const ws = new WS(url);
      const finish = (word: string | null) => {
        clearTimeout(timer);
        ws.close(1000, "done");
        done(word);
      };
      const timer = setTimeout(() => finish("timeout"), SEND_MS);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", key, proto: PROTO })));
      ws.addEventListener("message", (e: { data: string }) => {
        const f = parseFrame(e.data);
        // roster — hello принят
        if (f?.type === "roster") ws.send(JSON.stringify({ ...frame, id }));
        else if (f && isReply(f) && f.id === id) finish(f.ok ? null : f.error);
      });
      ws.addEventListener("close", (e: { code: number; reason: string }) => finish(e.reason || String(e.code)));
    });
  }

  async function answer(frame: Frame | undefined): Promise<string | null> {
    const key = await o.store.get<string>("key");
    if (!key) return "no_key";
    const machine = frame && hostOf(frame);
    if (!machine || !frame) return "bad_frame";
    let url: string;
    try {
      url = await o.relayUrl;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return send(`${url.replace(/\/$/, "")}/m/${machine}`, key, frame);
  }

  async function onClick(data: Shown, action: string) {
    if (!action) return open(data.id);
    const word = await answer(data.frames[Number(action)]);
    if (!word) return;
    console.error(`switchboard: ответ из уведомления не отправлен — ${word}`);
    await show(`Ответ не отправлен: ${word}`, data);
  }

  scope.addEventListener("install", (e) => e.waitUntil(scope.skipWaiting()));
  scope.addEventListener("activate", (e) => e.waitUntil(scope.clients.claim()));
  scope.addEventListener("push", (e) => e.waitUntil(onPush(e.data)));
  scope.addEventListener("notificationclick", (e) => {
    e.notification.close();
    e.waitUntil(onClick(e.notification.data, e.action));
  });
}
