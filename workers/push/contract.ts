// Контракт push: веб-пуши клиентам рации. Запросы — кадры с to: ".push", ответ — reply через relay.

/** Имена и версии, которые push обслуживает. */
export const CONTRACT = { "push.key": 1, "push.send": 1, "push.subscribe": 1 } as const;

/** Что показать: заголовок, текст и кнопки. push его не разбирает, только укорачивает body. */
export type Notify = {
  title?: string;
  body?: string;
  actions?: Array<{ title: string; frame?: unknown }>;
  [field: string]: unknown;
};

/** push.key — открытый ключ VAPID. Ответ: { key } — несжатая точка P-256 в base64url. */
export type PushKey = { type: "push.key"; id: string; to: ".push" };
export type PushKeyResult = { key: string };

/** Подписка браузера: PushSubscription.toJSON(). */
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/** push.subscribe — подписка клиента; имя клиента push берёт из from. Ответ: ok без result. */
export type PushSubscribe = { type: "push.subscribe"; id: string; to: ".push"; sub: Subscription };

/**
 * push.send — пуш подпискам, до которых доходит push.to: адрес устройства — ему, адрес человека ~email — каждому его устройству,
 * кроме skip (устройства на связи). Внутри уведомления — type, from и notify; строка журнала на каждое устройство.
 * Ответ: { cut } — укорачивал ли push notify.body, чтобы тело влезло в 4 096 Б; ok — пуш ушёл хотя бы одному.
 */
export type PushSend = {
  type: "push.send";
  id: string;
  to: ".push";
  push: { to: string; skip?: string[]; type: string; from?: string; notify: Notify };
};
export type PushSendResult = { cut: boolean };

/** Слова отказа push (кроме общих bad_frame, unknown_request, contract_mismatch). */
export type PushWord = "gone" | "push_failed";
