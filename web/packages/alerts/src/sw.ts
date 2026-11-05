// Обработчик пушей: показ, сохранение для страницы, ответ по кнопке коротким соединением. Отдельный бандл: рантайма страницы здесь нет.
import { hostOf, withLimit, type Frame } from "@switchboard/protocol";
import { link, type WsCtor } from "@switchboard/relay";
import type { Store } from "@switchboard/web-core";

export type SwScope = {
  addEventListener(type: string, fn: (e: any) => void): void;
  skipWaiting(): Promise<unknown>;
  registration: { scope: string; showNotification(title: string, o: Record<string, unknown>): Promise<unknown> };
  clients: {
    claim(): Promise<unknown>;
    matchAll(o: Record<string, unknown>): Promise<ReadonlyArray<{ focus(): Promise<unknown>; postMessage(m: unknown): void }>>;
    openWindow(url: string): Promise<unknown>;
  };
};

type Notify = { title?: string; body?: string; tag?: string; actions?: Array<{ title: string; frame?: Frame }> };
type Options = { relayUrl: string | Promise<string>; store: Store; maxActions: () => number; WebSocket?: WsCtor };
type Saved = { id: string; clicked?: boolean };

/** Предел ответа по кнопке: обработчик не живёт дольше сам. */
const SEND_MS = 30_000;

/** Отправить кадр кнопки relay машины адресата; ответ — слово отказа или null. */
async function sendFrame(frame: Frame, o: Options): Promise<string | null> {
  const key = await o.store.get<string>("key");
  if (!key) return "no_key";
  const machine = hostOf(frame);
  if (!machine) return "bad_frame";
  const relay = String(await o.relayUrl).replace(/\/$/, "");
  let done!: (word: string | null) => void;
  const finished = new Promise<string | null>((r) => (done = r));
  const l = link({
    url: `${relay}/m/${machine}`,
    key,
    WebSocket: o.WebSocket,
    onState(state, why) {
      if (state === "stopped") done(why ?? "stopped");
      if (state === "open") void l.request(frame).then((r) => done(r.ok ? null : r.error));
    },
  });
  const word = await withLimit(finished, SEND_MS, () => "timeout");
  l.close(1000, "done");
  return word;
}

export function serviceWorker(scope: SwScope, o: Options): void {
  async function onPush(data: { json(): { type?: unknown; from?: unknown; notify?: Notify } } | null): Promise<void> {
    let message;
    try {
      message = data?.json();
    } catch {
      // ниже та же причина: пуш не по форме
    }
    if (typeof message?.type !== "string") return void console.error("switchboard: пуш не по форме — нет type");
    const { type, from, notify } = message;
    const n = notify ?? {};
    const id = crypto.randomUUID();
    await o.store.update<Saved[]>("pushes", (old) => [...(old ?? []), { id, type, from, notify, at: Date.now() } as Saved]);
    const buttons = n.actions ?? [];
    const allFit = buttons.length <= o.maxActions() && buttons.every((a) => a.frame);
    await scope.registration.showNotification(n.title ?? (typeof from === "string" ? from : "Switchboard"), {
      body: n.body,
      tag: n.tag,
      icon: "icon-192.png",
      actions: allFit ? buttons.map((a, i) => ({ action: String(i), title: a.title })) : [],
      data: { id, notify: n },
    });
  }

  async function answerByButton(frame: Frame, n: Notify): Promise<void> {
    const word = await sendFrame(frame, o);
    if (word === null) return;
    console.error(`switchboard: ответ из уведомления не отправлен — ${word}`);
    await scope.registration.showNotification(`Ответ не отправлен: ${word}`, { body: n.body, tag: n.tag, icon: "icon-192.png" });
  }

  async function openApp(id: string): Promise<void> {
    await o.store.update<Saved[]>("pushes", (old) => (old ?? []).map((p) => (p.id === id ? { ...p, clicked: true } : p)));
    const [win] = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!win) return void (await scope.clients.openWindow(scope.registration.scope));
    win.postMessage("pushes");
    await win.focus();
  }

  scope.addEventListener("install", (e) => e.waitUntil(scope.skipWaiting()));
  scope.addEventListener("activate", (e) => e.waitUntil(scope.clients.claim()));
  scope.addEventListener("push", (e) => e.waitUntil(onPush(e.data)));
  scope.addEventListener("notificationclick", (e) => {
    e.notification.close();
    const { id, notify: n } = e.notification.data as { id: string; notify: Notify };
    const frame = e.action === "" ? undefined : n.actions?.[Number(e.action)]?.frame;
    e.waitUntil(frame ? answerByButton(frame, n) : openApp(id));
  });
}
