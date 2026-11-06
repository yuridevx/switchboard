// Контракт push: веб-пуши клиентам рации. Запросы — кадры с to: ".push", ответ — reply через relay.

/** Имена и версии, которые push обслуживает. */
export const CONTRACT = { "push.key": 1, "push.send": 1, "push.subscribe": 1, "push.subscribed": 1 } as const;

import type { Notify, RoomsSend } from "@switchboard/rooms";

/** Что показать: push его не разбирает, только укорачивает body. */
export type { Notify };

/** push.key — открытый ключ VAPID. Ответ: { key } — несжатая точка P-256 в base64url. */
export type PushKey = { type: "push.key"; id: string; to: ".push" };
export type PushKeyResult = { key: string };

/** Подписка браузера: PushSubscription.toJSON(). */
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/** push.subscribe — подписка клиента; имя клиента push берёт из from. Ответ: ok без result. */
export type PushSubscribe = { type: "push.subscribe"; id: string; to: ".push"; sub: Subscription };

/** push.subscribed — дойдёт ли пуш до этого браузера: есть строка клиента с этим адресом и этим пропуском. Ответ: { subscribed }. */
export type PushSubscribed = { type: "push.subscribed"; id: string; to: ".push"; endpoint: string };
export type PushSubscribedResult = { subscribed: boolean };

/**
 * push.send — пуш подпискам, до которых доходит push.to: адрес устройства — ему, адрес человека ~email — каждому его устройству,
 * кроме skip (устройства на связи). Внутри уведомления — type, from и notify; строка журнала на каждое устройство.
 * Ответ: ok — пуш ушёл хотя бы одному. Текст, который не влез в 4 096 Б, укорочен; cut — в строке журнала.
 */
export type PushSend = {
  type: "push.send";
  id: string;
  to: ".push";
  push: RoomsSend;
};

/** Слова отказа push (кроме общих bad_frame, unknown_request, contract_mismatch). */
export type PushWord = "gone" | "push_failed";
