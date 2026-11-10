// Уведомления этого устройства: состояние, подписка браузера ключом флота, сервис-воркер.
import { reachKey, reachSubscribe, type Api } from "@sb/protocol";
import { kvGet, kvSet } from "./kv.ts";

/** Пуш, пришедший без открытой страницы: его сохранил сервис-воркер. hash — куда он ведёт. */
export type Missed = { title: string; text?: string; callsign?: string; kind?: string; ask?: string; at: number; hash: string };

/** Что показать при открытии: по одному на сессию и вид (последний), свежие сверху, не больше пяти; остальное — числом. */
export function missedOf(list: Missed[], limit = 5): { shown: Missed[]; rest: number } {
  const by = new Map<string, Missed>();
  for (const m of list) if (m && typeof m.at === "number" && typeof m.hash === "string") by.set(`${m.callsign ?? ""}:${m.kind ?? ""}:${m.callsign ? "" : m.title}`, m);
  const all = [...by.values()].sort((a, b) => b.at - a.at);
  return { shown: all.slice(0, limit), rest: Math.max(0, all.length - limit) };
}

/** Забрать сохранённые пуши: читаются один раз и стираются. */
export async function takeMissed(): Promise<Missed[]> {
  const raw = await kvGet("pushes");
  if (!raw) return [];
  await kvSet("pushes", null);
  try {
    const list = JSON.parse(raw) as Missed[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Состояние уведомлений на устройстве:
 *  install — iPhone вне экрана «Домой»: пуши там не работают, нужна установка; unsupported — браузер не умеет;
 *  denied — человек отказал браузеру; off — можно включить; on — подписка есть. */
export type PushState = "install" | "unsupported" | "denied" | "off" | "on";

type Env = { ua: string; standalone: boolean; hasSw: boolean; hasPush: boolean; permission: NotificationPermission | undefined; subscribed: boolean };

export const isIos = (ua: string) => /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));

/** Чистое правило состояния. */
export function pushStateOf(e: Env): PushState {
  if (isIos(e.ua) && !e.standalone) return "install";
  if (!e.hasSw || !e.hasPush || e.permission === undefined) return "unsupported";
  if (e.permission === "denied") return "denied";
  return e.permission === "granted" && e.subscribed ? "on" : "off";
}

const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
  } catch {
    return null;
  }
}

export async function pushState(): Promise<PushState> {
  const reg = "serviceWorker" in navigator && "PushManager" in window ? await registration() : null;
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return pushStateOf({
    ua: navigator.userAgent, standalone: standalone(), hasSw: "serviceWorker" in navigator && !!reg, hasPush: "PushManager" in window,
    permission: typeof Notification === "undefined" ? undefined : Notification.permission, subscribed: !!sub,
  });
}

/** Ключ сервера приложения из base64url — байтами, как его ждёт браузер. */
export function keyBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const b64url = (buf: ArrayBuffer | null) => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "");

/** Поля подписки браузера для запроса reach.subscribe. */
export function subscriptionFields(sub: { endpoint: string; getKey(name: "p256dh" | "auth"): ArrayBuffer | null }): { endpoint: string; p256dh: string; auth: string } {
  return { endpoint: sub.endpoint, p256dh: b64url(sub.getKey("p256dh")), auth: b64url(sub.getKey("auth")) };
}

/** Имя устройства для списка: что за браузер и где. */
export function deviceLabel(ua: string): string {
  const where = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "устройство";
  const what = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "браузер";
  return `${where}, ${what}`;
}

/** Включить уведомления: разрешение браузера → подписка ключом флота → запись устройства у службы. Ответ — новое состояние. */
export async function enablePush(api: Api): Promise<PushState> {
  const reg = await registration();
  if (!reg || !("PushManager" in window) || typeof Notification === "undefined") return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const { key } = await api.call(reachKey, {});
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource }));
  await api.call(reachSubscribe, { kind: "webpush", ...subscriptionFields(sub), label: deviceLabel(navigator.userAgent) });
  return "on";
}

/** Снять подписку браузера (запись устройства убирает экран настроек запросом reach.remove). */
export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  await sub?.unsubscribe().catch(() => {});
}

/** Сервис-воркер просит открыть сессию из уведомления: страница переходит без перезагрузки. */
export function onOpenFromPush(go: (hashPath: string) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const on = (e: MessageEvent) => e.data?.type === "open" && typeof e.data.hash === "string" && go(e.data.hash);
  navigator.serviceWorker.addEventListener("message", on);
  return () => navigator.serviceWorker.removeEventListener("message", on);
}
