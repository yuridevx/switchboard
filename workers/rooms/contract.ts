// Контракт rooms: чаты Telegram как устройства людей. Адрес telegram~ann@x.y — личка, team~ann@x.y — группа, за которую она отвечает: пропуск gate, отзыв — keys.revoke.
// Сессия в чате — своя тема с именем callsign. Людей, сообщений и вопросов служба не хранит: участников знает Telegram, разговор — сессия, вопрос — Host.
// Вход: привязка send для Worker'а push и POST /webhook от Telegram; POST /setup — регистрация вебхука при выкладке.
// Кадр в Host — через relay.deliver: rooms.message с ответом человека, им пользуется host-chat.
// В группе пишут только люди с живой привязкой лички: from — адрес группы, author — имя автора.

/** Человек написал в тему сессии или нажал кнопку вопроса: question — номер вопроса, text — подпись кнопки. Без id: ответа никто не ждёт, исход виден реакцией. */
export type RoomsMessage = { type: "rooms.message"; v: 1; to: string; from: string; text: string; author?: string; question?: string };

/** Что показать: то же, что push показывает в браузере. tag — номер вопроса, идёт в кнопки; app — в чате не ответить, только в приложении. */
export type Notify = { title?: string; body?: string; actions?: Array<{ title: string; frame?: unknown }>; tag?: string; app?: boolean; [field: string]: unknown };

/** rooms.send: to — устройство или человек ~email (только его личка), skip — устройства на связи, from — сессия. */
export type RoomsSend = { to: string; skip?: string[]; type: string; from?: string; notify: Notify };

/**
 * no_topics — в группе нет тем или у бота нет права; rate_limited — предел Telegram, why называет секунды;
 * too_long — текст больше предела; gone — бота убрали или заблокировали; send_failed — Telegram не ответил.
 */
export type RoomsWord = "no_topics" | "rate_limited" | "too_long" | "gone" | "send_failed";

/** Сколько чатов получили сообщение; word — отказ Telegram, why — что делать. Чатов у адреса нет: sent 0 без word. */
export type RoomsSent = { sent: number; word?: RoomsWord; why?: string };

export interface RoomsApi {
  send(push: RoomsSend): Promise<RoomsSent>;
}
