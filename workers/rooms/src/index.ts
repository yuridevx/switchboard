// Worker rooms: чаты Telegram как устройства людей. Наружу — rooms.send; внутрь — вебхук Telegram → кадр в Host через relay. Состояния нет: всё в D1.
import { WorkerEntrypoint } from "cloudflare:workers";
import { kindOf, reaches, type Frame, within } from "@switchboard/protocol";
import type { RoomsApi, RoomsSend, RoomsSent } from "../contract.ts";
import type { Env } from "./env.ts";
import { ackButton, dropButtons, hook, newTopic, post, react, refusal, say, threadGone } from "./telegram.ts";

type Row = Record<string, unknown>;
type Chat = { chat: number; addr: string; kid: string };
type Person = { id: number; first_name?: string; is_bot?: boolean };
type Message = { message_id: number; chat: { id: number; type: string }; message_thread_id?: number; from?: Person; text?: string; caption?: string };
type Button = { id: string; from: Person; data?: string; message?: Message };
type Update = { message?: Message; callback_query?: Button };

const SEEN = "👀"; // дошло до машины
const NOBODY = "🤷"; // машина не на связи или такое сообщение сессии не передать
const REFUSED = "👎"; // отправитель не привязан к флоту

/** Приглашение: в ссылке точка заменена на _: Telegram не принимает её в параметре. */
const INVITE = /^(?:\/start(?:@\w+)?\s+)?([a-z0-9]{4})[._]([\w-]{43})\s*$/;

const log = (row: Row) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "rooms", ...row }));

const private_ = (chat: number) => chat > 0;

/** Секрет вебхука выводится из токена бота: второго секрета нет. */
async function hookSecret(env: Env): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`webhook|${env.TELEGRAM_BOT_TOKEN}`));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Чат без отозванных: отозванный удаляется, адрес больше не отвечает. */
async function alive(env: Env, chats: Chat[]): Promise<Chat[]> {
  if (!chats.length) return [];
  const revoked = new Set(await within(env.GATE.revoked(chats.map((c) => c.kid)), "gate не ответил на revoked"));
  for (const c of chats.filter((x) => revoked.has(x.kid))) {
    await env.DB.batch([env.DB.prepare("DELETE FROM chats WHERE chat = ?").bind(c.chat), env.DB.prepare("DELETE FROM threads WHERE chat = ?").bind(c.chat), env.DB.prepare("DELETE FROM asks WHERE chat = ?").bind(c.chat)]);
    log({ kind: "refuse", ev: "revoked", word: "gone", why: `пропуск ${c.kid} отозван: ${c.addr} отвязан`, client: c.addr });
  }
  return chats.filter((c) => !revoked.has(c.kid));
}

/** Текст сообщения: у обычного — тело модели, у вопроса и его исхода — ещё заголовок. */
const shown = ({ type, notify }: RoomsSend): string => (type === "message" ? String(notify.body ?? "") : [notify.title && `**${notify.title}**`, notify.body].filter(Boolean).join("\n\n"));

/** Тема сессии в чате: первая запись сессии создаёт её. Обе записи одновременно — вторая тема остаётся пустой, в базе одна. */
async function topic(env: Env, chat: number, callsign: string) {
  const known = await env.DB.prepare("SELECT thread FROM threads WHERE callsign = ? AND chat = ?").bind(callsign, chat).first<{ thread: number }>();
  if (known) return { thread: known.thread };
  const made = await newTopic(env.TELEGRAM_BOT_TOKEN, chat, callsign);
  if (!made.ok) return { refused: refusal(made) };
  await env.DB.prepare("INSERT OR IGNORE INTO threads (callsign, chat, thread) VALUES (?, ?, ?)").bind(callsign, chat, made.result!.message_thread_id).run();
  const row = await env.DB.prepare("SELECT thread FROM threads WHERE callsign = ? AND chat = ?").bind(callsign, chat).first<{ thread: number }>();
  return { thread: row!.thread };
}

/** Одно сообщение одному чату. null — ушло, иначе отказ. */
async function deliver(env: Env, c: Chat, push: RoomsSend, callsign: string): Promise<RoomsSent | null> {
  const got = await topic(env, c.chat, callsign);
  if (got.refused) return { sent: 0, ...got.refused };
  const actions = push.notify.actions ?? [];
  const silent = !private_(c.chat) && push.type !== "question";
  const a = await post(env.TELEGRAM_BOT_TOKEN, c.chat, got.thread!, shown(push), silent, actions.map((x) => x.title));
  if (!a.ok) {
    const no = refusal(a);
    if (threadGone(a)) await env.DB.prepare("DELETE FROM threads WHERE callsign = ? AND chat = ?").bind(callsign, c.chat).run();
    log({ kind: "refuse", ev: "rooms.send", word: no.word, why: no.why, client: c.addr, from: callsign });
    return { sent: 0, ...no };
  }
  if (actions.length) await env.DB.prepare("INSERT OR REPLACE INTO asks (chat, message, actions) VALUES (?, ?, ?)").bind(c.chat, a.result!.message_id, JSON.stringify(actions)).run();
  log({ kind: "note", ev: "sent", client: c.addr, from: callsign, type: push.type });
  return null;
}

/** Человеку ~email — только его личка: группа не его устройство, а общий чат. */
async function send(env: Env, push: RoomsSend): Promise<RoomsSent> {
  const { to, skip = [], from } = push;
  if (kindOf(from) !== "session") return { sent: 0 };
  const { results } = await env.DB.prepare("SELECT chat, addr, kid FROM chats WHERE substr(addr, -length(?1)) = ?1").bind(to).all<Chat>();
  const targets = await alive(env, results.filter((c) => reaches(to, c.addr) && !skip.includes(c.addr) && (kindOf(to) !== "user" || private_(c.chat))));
  const refused = (await Promise.all(targets.map((c) => deliver(env, c, push, from!)))).filter((r) => r !== null);
  return { sent: targets.length - refused.length, ...(refused[0] ? { word: refused[0].word, why: refused[0].why } : {}) };
}

/** Приглашение принято: чат стал устройством. Пропуск не хранится: номер — всё, что нужно для отзыва. */
async function link(env: Env, m: Message, invite: string): Promise<void> {
  const chat = m.chat.id;
  const token = env.TELEGRAM_BOT_TOKEN;
  const got = await within(env.GATE.redeem(invite), "gate не ответил на redeem");
  if ("error" in got) {
    log({ kind: "refuse", ev: "link", word: got.error, why: `приглашение чата ${chat} не принято` });
    await react(token, chat, m.message_id, REFUSED);
    return;
  }
  const who = await within(env.GATE.verify(got.key), "gate не ответил на verify");
  if ("error" in who) throw new Error(`принятый пропуск не прошёл verify: ${who.error}`);
  await env.DB.prepare("INSERT OR REPLACE INTO chats (chat, addr, kid, at) VALUES (?, ?, ?, ?)").bind(chat, who.addr, who.kid, Date.now()).run();
  log({ kind: "note", ev: "link", client: who.addr, kid: who.kid });
  await say(token, chat, `Привязано: ${who.addr}`);
}

const chatOf = (env: Env, id: number) => env.DB.prepare("SELECT chat, addr, kid FROM chats WHERE chat = ?").bind(id).first<Chat>();

/** Отправитель и чат с живыми пропусками: адрес чата и адрес человека. Чужой — null. */
async function sender(env: Env, chat: number, person: Person): Promise<{ place: string; who: string } | null> {
  const [room, own] = await Promise.all([chatOf(env, chat), chatOf(env, person.id)]);
  if (!room || !own) return null;
  const left = await alive(env, room.chat === own.chat ? [room] : [room, own]);
  return left.length === (room.chat === own.chat ? 1 : 2) ? { place: room.addr, who: own.addr } : null;
}

const callsignOf = async (env: Env, chat: number, thread: number | undefined) =>
  thread === undefined ? null : ((await env.DB.prepare("SELECT callsign FROM threads WHERE chat = ? AND thread = ?").bind(chat, thread).first<{ callsign: string }>())?.callsign ?? null);

const toHost = (env: Env, f: Frame) => within(env.RELAY.deliver(f), "relay не ответил");

/** Сообщение человека. General и чужие темы в группе — разговор людей: бот молчит. */
async function onMessage(env: Env, m: Message): Promise<void> {
  const chat = m.chat.id;
  const token = env.TELEGRAM_BOT_TOKEN;
  const text = m.text ?? m.caption;
  const invite = text?.match(INVITE);
  if (invite) return link(env, m, `${invite[1]}.${invite[2]}`);
  const callsign = await callsignOf(env, chat, m.message_thread_id);
  if (!callsign) {
    if (private_(chat)) await react(token, chat, m.message_id, NOBODY);
    return;
  }
  const by = m.from?.is_bot ? null : await sender(env, chat, m.from ?? { id: 0 });
  if (!by) {
    log({ kind: "refuse", ev: "message", word: "not_linked", why: `${m.from?.id} не привязан`, callsign });
    await react(token, chat, m.message_id, REFUSED);
    return;
  }
  if (!text) {
    log({ kind: "refuse", ev: "message", word: "not_text", why: "вложения сессии не передаются", callsign });
    await react(token, chat, m.message_id, NOBODY);
    return;
  }
  // автор — именем: адрес в тексте модель принимает за адрес ответа, а ответ идёт в from
  const said = private_(chat) ? text : `${m.from?.first_name ?? by.who}: ${text}`;
  const n = await toHost(env, { type: "rooms.message", v: 1, to: callsign, from: by.place, text: said });
  await react(token, chat, m.message_id, n ? SEEN : NOBODY);
}

/** Нажатая кнопка вопроса: кадр дал тот, кто спросил, служба его не разбирает. Запрос: id нужен Host, ответ никто не ждёт. Первый ответ выигрывает у Host. */
async function onButton(env: Env, b: Button): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const m = b.message;
  const callsign = m && (await callsignOf(env, m.chat.id, m.message_thread_id));
  const by = m && (await sender(env, m.chat.id, b.from));
  if (!m || !callsign || !by) {
    log({ kind: "refuse", ev: "button", word: "not_linked", why: `${b.from.id} не привязан или темы нет` });
    await ackButton(token, b.id, "Нет привязки к флоту");
    return;
  }
  const row = await env.DB.prepare("SELECT actions FROM asks WHERE chat = ? AND message = ?").bind(m.chat.id, m.message_id).first<{ actions: string }>();
  const frame = row && (JSON.parse(row.actions) as Array<{ frame?: Frame }>)[Number(b.data)]?.frame;
  if (!frame) {
    await ackButton(token, b.id, "Вопрос уже снят");
    return;
  }
  const n = await toHost(env, { ...frame, id: crypto.randomUUID(), to: callsign, from: by.place });
  if (!n) {
    await ackButton(token, b.id, "Машина не на связи");
    return;
  }
  await env.DB.prepare("DELETE FROM asks WHERE chat = ? AND message = ?").bind(m.chat.id, m.message_id).run();
  await dropButtons(token, m.chat.id, m.message_id);
  await ackButton(token, b.id);
}

/** Вебхук: 401 — не Telegram; остальное 200: повтор доставки дал бы двойной ввод, исход человек видит реакцией. */
async function webhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST" || req.headers.get("x-telegram-bot-api-secret-token") !== (await hookSecret(env))) return new Response(null, { status: 401 });
  const u = (await req.json()) as Update;
  try {
    if (u.message) await onMessage(env, u.message);
    else if (u.callback_query) await onButton(env, u.callback_query);
  } catch (e) {
    log({ kind: "stop", ev: "webhook", word: "failed", why: String(e) });
  }
  return new Response(null, { status: 200 });
}

/** Регистрация вебхука при выкладке: адрес — свой, секрет — выведенный. Вход — токен бота. */
async function setup(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST" || req.headers.get("authorization") !== `Bearer ${env.TELEGRAM_BOT_TOKEN}`) return new Response(null, { status: 401 });
  const a = await hook(env.TELEGRAM_BOT_TOKEN, `${new URL(req.url).origin}/webhook`, await hookSecret(env));
  log({ kind: a.ok ? "note" : "stop", ev: "setup", why: a.description });
  return Response.json({ ok: a.ok, description: a.description }, { status: a.ok ? 200 : 502 });
}

export class Rooms extends WorkerEntrypoint<Env> implements RoomsApi {
  send(push: RoomsSend): Promise<RoomsSent> {
    return send(this.env, push);
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    const { pathname } = new URL(req.url);
    if (pathname === "/webhook") return webhook(req, env);
    if (pathname === "/setup") return setup(req, env);
    return new Response("switchboard rooms: /webhook\n", { status: 404 });
  },
};
