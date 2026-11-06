// Контракт rooms: чаты Telegram как устройства людей. Адрес telegram~ann@x.y — личка, team~ann@x.y — группа, за которую она отвечает: пропуск gate, отзыв — keys.revoke.
// Сессия в чате — своя тема с именем callsign. Людей и сообщений служба не хранит: участников знает Telegram, разговор — сессия.
// Вход: привязка send для Worker'а push и POST /webhook от Telegram; POST /setup — регистрация вебхука при выкладке.
// Кадры в Host — через relay.deliver: свой rooms.message с ответом человека (им пользуется host-chat) и кадр кнопки, который дал спросивший.
// В группе пишут только люди с живой привязкой лички: from — адрес группы, автор — в начале текста.

export const CONTRACT = { "rooms.send": 1, "rooms.message": 1 } as const;

/** Человек написал в тему сессии. Без id: ответа никто не ждёт, исход виден реакцией. */
export type RoomsMessage = { type: "rooms.message"; v: 1; to: string; from: string; text: string };

/** Что показать: то же, что push показывает в браузере. */
export type Notify = { title?: string; body?: string; actions?: Array<{ title: string; frame?: unknown }>; [field: string]: unknown };

/** rooms.send: to — устройство или человек ~email (только его личка), skip — устройства на связи, from — сессия. */
export type RoomsSend = { to: string; skip?: string[]; type: string; from?: string; notify: Notify };

/**
 * no_topics — в группе нет тем или у бота нет права; rate_limited — предел Telegram, why называет секунды;
 * too_long — текст больше предела; gone — бота убрали, заблокировали или человек удалил тему; send_failed — Telegram не ответил.
 */
export type RoomsWord = "no_topics" | "rate_limited" | "too_long" | "gone" | "send_failed";

/** Сколько чатов получили сообщение; word — отказ Telegram, why — что делать. Чатов у адреса нет: sent 0 без word. */
export type RoomsSent = { sent: number; word?: RoomsWord; why?: string };

export interface RoomsApi {
  send(push: RoomsSend): Promise<RoomsSent>;
}
