// Worker rooms: чаты Telegram как устройства людей. Наружу — rooms.send; внутрь — вебхук Telegram → кадр в Host через relay. Состояния нет: всё в D1.
import { WorkerEntrypoint } from "cloudflare:workers";
import { inviteOf } from "@switchboard/gate";
import { isPerson, kindOf, reaches, within, type Frame } from "@switchboard/protocol";
import type { RoomsApi, RoomsMessage, RoomsSend, RoomsSent } from "../contract.ts";
import type { Env } from "./env.ts";
import { ackButton, dropButtons, hook, newTopic, post, react, refusal, say, threadGone } from "./telegram.ts";

type Row = Record<string, unknown>;
type Chat = { chat: number; addr: string; kid: string };
type Person = { id: number; first_name?: string; is_bot?: boolean };
type Message = {
  message_id: number;
  chat: { id: number; type: string; is_forum?: boolean };
  message_thread_id?: number;
  from?: Person;
  text?: string;
  caption?: string;
  reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
};
type Button = { id: string; from: Person; data?: string; message?: Message };
type Update = { message?: Message; callback_query?: Button };
/** Работа после ответа вебхуку. */
type After = (work: Promise<unknown>) => void;

const SEEN = "👀"; // дошло до машины
const NOBODY = "🤷"; // машина не на связи или такое сообщение сессии не передать
const REFUSED = "👎"; // отправитель не привязан к флоту

const log = (row: Row) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "rooms", ...row }));

const private_ = (chat: number) => chat > 0;

/** Реакцию сразу после сообщения Telegram принимает с ok, но не показывает: 0 и 100 мс — 0 из 6, от 250 мс — 9 из 9 (6 нояб.). */
const REACT_MS = 1000;

/** Реакция — единственный ответ человеку: отказ Telegram в журнале. */
async function mark(env: Env, chat: number, message: number, emoji: string): Promise<void> {
  await scheduler.wait(REACT_MS);
  const a = await react(env.TELEGRAM_BOT_TOKEN, chat, message, emoji);
  if (!a.ok) log({ kind: "refuse", ev: "react", word: "send_failed", why: a.description, chat, message, emoji });
}

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
    await env.DB.batch([env.DB.prepare("DELETE FROM chats WHERE chat = ?").bind(c.chat), env.DB.prepare("DELETE FROM threads WHERE chat = ?").bind(c.chat)]);
    log({ kind: "refuse", ev: "revoked", word: "gone", why: `пропуск ${c.kid} отозван: ${c.addr} отвязан`, client: c.addr });
  }
  return chats.filter((c) => !revoked.has(c.kid));
}

/** Текст сообщения: у обычного — тело модели, у вопроса и его исхода — ещё заголовок. Разрешение и форму в чате не ответить. */
function shown({ type, notify }: RoomsSend): string {
  if (type === "message") return String(notify.body ?? "");
  return [notify.title && `**${notify.title}**`, notify.body, notify.app && "Ответить можно в пульте."].filter(Boolean).join("\n\n");
}

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

/** Одно сообщение одному чату. null — ушло, иначе отказ. Человек удалил тему — строка устарела: новая тема и ещё одна попытка, повторить могла бы только модель. */
async function deliver(env: Env, c: Chat, push: RoomsSend, callsign: string, again = true): Promise<RoomsSent | null> {
  const got = await topic(env, c.chat, callsign);
  if (got.refused) return { sent: 0, ...got.refused };
  const { actions = [], tag } = push.notify;
  const silent = !private_(c.chat) && push.type !== "question";
  const buttons = tag ? actions.map((x, i) => ({ text: x.title, data: `${i}:${tag}` })) : [];
  const a = await post(env.TELEGRAM_BOT_TOKEN, c.chat, got.thread!, shown(push), silent, buttons);
  if (a.ok) {
    log({ kind: "note", ev: "sent", client: c.addr, from: callsign, type: push.type });
    return null;
  }
  if (threadGone(a)) {
    await env.DB.prepare("DELETE FROM threads WHERE callsign = ? AND chat = ?").bind(callsign, c.chat).run();
    if (again) return deliver(env, c, push, callsign, false);
  }
  const no = refusal(a);
  log({ kind: "refuse", ev: "rooms.send", word: no.word, why: no.why, client: c.addr, from: callsign });
  return { sent: 0, ...no };
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

/** Приглашение принято: чат стал устройством. Пропуск не хранится: номер — всё, что нужно для отзыва. Группа без тем отказывается до приёма: приглашение не сгорает. */
async function link(env: Env, m: Message, invite: string, after: After): Promise<void> {
  const chat = m.chat.id;
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!private_(chat) && !m.chat.is_forum) {
    log({ kind: "refuse", ev: "link", word: "no_topics", why: `группа ${chat} без тем` });
    await say(token, chat, "Включите темы в настройках группы и отправьте приглашение снова.");
    return;
  }
  const got = await within(env.GATE.redeem(invite), "gate не ответил на redeem");
  if ("error" in got || !isPerson(got.addr)) {
    log({ kind: "refuse", ev: "link", word: "error" in got ? got.error : "not_person", why: `приглашение чата ${chat} не принято` });
    after(mark(env, chat, m.message_id, REFUSED));
    return;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO chats (chat, addr, kid) VALUES (?, ?, ?)").bind(chat, got.addr, got.kid).run();
  log({ kind: "note", ev: "link", client: got.addr, kid: got.kid });
  await say(token, chat, `Привязано: ${got.addr}`);
}

const chatOf = (env: Env, id: number) => env.DB.prepare("SELECT chat, addr, kid FROM chats WHERE chat = ?").bind(id).first<Chat>();

/** Адрес чата, если у чата и отправителя живые пропуска. Чужой — null. */
async function sender(env: Env, chat: number, person: Person): Promise<string | null> {
  const [room, own] = await Promise.all([chatOf(env, chat), chatOf(env, person.id)]);
  if (!room || !own) return null;
  const left = await alive(env, room.chat === own.chat ? [room] : [room, own]);
  return left.length === (room.chat === own.chat ? 1 : 2) ? room.addr : null;
}

const callsignOf = async (env: Env, chat: number, thread: number | undefined) =>
  thread === undefined ? null : ((await env.DB.prepare("SELECT callsign FROM threads WHERE chat = ? AND thread = ?").bind(chat, thread).first<{ callsign: string }>())?.callsign ?? null);

const toHost = (env: Env, f: RoomsMessage) => within(env.RELAY.deliver(f as unknown as Frame), "relay не ответил");

/** Текст для сессии: вложений она не получает, подпись к ним идёт с пометкой. */
const textOf = (m: Message) => m.text ?? (m.caption ? `${m.caption}\n(вложение не передано)` : undefined);

/** Сообщение человека. General и чужие темы в группе — разговор людей: бот молчит. */
async function onMessage(env: Env, m: Message, after: After): Promise<void> {
  const chat = m.chat.id;
  const invite = m.text ? inviteOf(m.text.replace(/^\/start(?:@\w+)?\s+/, "")) : null;
  if (invite) return link(env, m, invite, after);
  const callsign = await callsignOf(env, chat, m.message_thread_id);
  if (!callsign) {
    if (private_(chat)) after(mark(env, chat, m.message_id, NOBODY));
    return;
  }
  const from = m.from?.is_bot ? null : await sender(env, chat, m.from ?? { id: 0 });
  if (!from) {
    log({ kind: "refuse", ev: "message", word: "not_linked", why: `${m.from?.id} не привязан`, callsign });
    after(mark(env, chat, m.message_id, REFUSED));
    return;
  }
  const text = textOf(m);
  if (!text) {
    log({ kind: "refuse", ev: "message", word: "not_text", why: "вложения сессии не передаются", callsign });
    after(mark(env, chat, m.message_id, NOBODY));
    return;
  }
  const n = await toHost(env, { type: "rooms.message", v: 1, to: callsign, from, text, ...(private_(chat) ? {} : { author: m.from?.first_name }) });
  after(mark(env, chat, m.message_id, n ? SEEN : NOBODY));
}

/** Нажатая кнопка вопроса: подпись и номер вопроса приходят с самой кнопкой, хранить нечего. Вопрос уже снят — скажет Host. */
async function onButton(env: Env, b: Button): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const m = b.message;
  const callsign = m && (await callsignOf(env, m.chat.id, m.message_thread_id));
  const from = m && (await sender(env, m.chat.id, b.from));
  if (!m || !callsign || !from) {
    log({ kind: "refuse", ev: "button", word: "not_linked", why: `${b.from.id} не привязан или темы нет` });
    await ackButton(token, b.id, "Нет привязки к флоту");
    return;
  }
  const question = /^\d+:(.+)$/.exec(b.data ?? "")?.[1];
  const label = m.reply_markup?.inline_keyboard?.flat().find((x) => x.callback_data === b.data)?.text;
  if (!question || !label) {
    await ackButton(token, b.id, "Вопрос уже снят");
    return;
  }
  const n = await toHost(env, { type: "rooms.message", v: 1, to: callsign, from, text: label, question });
  if (!n) {
    await ackButton(token, b.id, "Машина не на связи");
    return;
  }
  await dropButtons(token, m.chat.id, m.message_id);
  await ackButton(token, b.id);
}

/** Сбой gate, relay или базы: человек видит исход, повтора нет. */
async function failed(env: Env, u: Update, e: unknown, after: After): Promise<void> {
  log({ kind: "stop", ev: "webhook", word: "failed", why: String(e) });
  if (u.message) after(mark(env, u.message.chat.id, u.message.message_id, NOBODY));
  else if (u.callback_query) await ackButton(env.TELEGRAM_BOT_TOKEN, u.callback_query.id, "Машина не на связи");
}

/** Вебхук: 401 — не Telegram; остальное 200: повтор доставки дал бы двойной ввод. Реакция — после ответа, чтобы ответ не опаздывал. */
async function webhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "POST" || req.headers.get("x-telegram-bot-api-secret-token") !== (await hookSecret(env))) return new Response(null, { status: 401 });
  const u = (await req.json()) as Update;
  const after: After = (work) => ctx.waitUntil(work);
  try {
    if (u.message) await onMessage(env, u.message, after);
    else if (u.callback_query) await onButton(env, u.callback_query);
  } catch (e) {
    await failed(env, u, e, after);
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
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const { pathname } = new URL(req.url);
    if (pathname === "/webhook") return webhook(req, env, ctx);
    if (pathname === "/setup") return setup(req, env);
    return new Response("switchboard rooms: /webhook\n", { status: 404 });
  },
};
