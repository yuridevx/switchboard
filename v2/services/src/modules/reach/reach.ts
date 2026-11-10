// Связь с людьми: устройства человека вне страницы — подписки веб-пуша и чаты Telegram, записи одного вида.
// Один запрос «позвать человека»: служба сама спрашивает платформу, на связи ли он; на связи — не шлёт.
// Бот Telegram у каждого флота свой: его токен лежит в записях флота, вебхук приходит на адрес этого флота — общей для флотов записи нет.
import { CALL_MS, errFields, type Frame, type Logger, newId, Refusal, sha256hex } from "@sb/protocol";
import { outbound } from "../../env.ts";
import type { Deps, Env, Module, Platform } from "../../env.ts";
import { log } from "../../entrance.ts";
import { type Db, records } from "../../records.ts";
import { encrypt, MAX_PLAIN, publicKey, unb64u, vapid } from "./webpush.ts";

const NAME = "reach";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, kind TEXT, person TEXT, label TEXT, at INTEGER, kid TEXT, endpoint TEXT, p256dh TEXT, auth TEXT, chat INTEGER)",
  "CREATE INDEX IF NOT EXISTS devices_person ON devices (person)",
  "CREATE TABLE IF NOT EXISTS threads (chat INTEGER, callsign TEXT, thread INTEGER, PRIMARY KEY (chat, callsign))",
  "CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, person TEXT, kid TEXT, at INTEGER)",
  // бот флота: одна строка
  "CREATE TABLE IF NOT EXISTS bot (one INTEGER PRIMARY KEY CHECK (one = 1), token TEXT NOT NULL, name TEXT NOT NULL)",
  // чат: кто его привязал (номер человека в Telegram) и группа ли это с темами
  "CREATE TABLE IF NOT EXISTS tg (chat INTEGER PRIMARY KEY, author INTEGER, forum INTEGER)",
  // сообщения бота о сессиях: ответ на такое сообщение и кнопка под ним идут этой сессии
  "CREATE TABLE IF NOT EXISTS sent (chat INTEGER, msg INTEGER, callsign TEXT, at INTEGER, PRIMARY KEY (chat, msg))",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

type Device = { id: string; kind: "webpush" | "telegram"; person: string; label: string | null; at: number; kid: string | null; endpoint: string | null; p256dh: string | null; auth: string | null; chat: number | null };
type Note = { title: string; text: string; callsign?: string; kind?: string; ask?: string; options?: string[] };
type Bot = { token: string; name: string };

const B64U = /^[A-Za-z0-9_-]+$/;
const DAY = 24 * 3600 * 1000;
const SENT_KEEP = 30 * DAY;

const botOf = (env: Env, fleet: string) => db(env, fleet).first<Bot>("SELECT token, name FROM bot WHERE one = 1");

/* ===== Веб-пуш ===== */

const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** Открытый текст пуша в пределе службы: длинный текст укорачивается с «…». */
function fit(n: Note): Uint8Array | null {
  const whole = bytes(n);
  if (whole.length <= MAX_PLAIN) return whole;
  const chars = Array.from(n.text);
  const cut = (k: number) => bytes({ ...n, text: chars.slice(0, k).join("") + "…" });
  if (cut(0).length > MAX_PLAIN) return null;
  let [lo, hi] = [0, chars.length];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cut(mid).length <= MAX_PLAIN) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

/** Чем работает отправка: вызывается и запросом reach.send, и оповещением о сбоях. */
export interface Sender {
  env: Env;
  fleet: string;
  platform: Platform;
  fetch: typeof fetch;
  log: Logger;
}

/** Один пуш одной подписке. Служба ответила «подписки нет» — устройство убирается. */
async function push(c: Sender, d: Device, plain: Uint8Array): Promise<boolean> {
  const jwk = JSON.parse(c.env.VAPID_PRIVATE!) as JsonWebKey;
  const body = await encrypt(plain, unb64u(d.p256dh!), unb64u(d.auth!));
  const headers = { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high", authorization: await vapid(jwk, d.endpoint!, c.env.VAPID_SUB ?? "mailto:fleet@example.com") };
  let status: number;
  try {
    status = (await c.fetch(d.endpoint!, { method: "POST", headers, body, signal: AbortSignal.timeout(CALL_MS) })).status;
  } catch (e) {
    c.log.warn("служба пушей не ответила", { device: d.id, ...errFields(e) });
    return false;
  }
  if (status >= 200 && status < 300) return true;
  if (status === 404 || status === 410) await db(c.env, c.fleet).run("DELETE FROM devices WHERE id = ?", d.id);
  c.log.warn("пуш не принят", { device: d.id, status });
  return false;
}

/* ===== Telegram ===== */

type TgAnswer<T = Record<string, unknown>> = { ok: boolean; result?: T; error_code?: number; description?: string };

async function bot<T>(f: typeof fetch, token: string, method: string, body: unknown): Promise<TgAnswer<T>> {
  try {
    const res = await f(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
    return (await res.json()) as TgAnswer<T>;
  } catch (e) {
    return { ok: false, description: `Telegram не ответил: ${e}` };
  }
}

const threadGone = (a: TgAnswer<unknown>) => /thread not found/i.test(a.description ?? "");

/** Тема сессии в чате: первая запись сессии создаёт её. Тем в чате нет — null: сообщение уйдёт в общий поток с позывным. */
async function topic(f: typeof fetch, token: string, d: Db, chat: number, callsign: string): Promise<number | null> {
  const known = await d.first<{ thread: number }>("SELECT thread FROM threads WHERE chat = ? AND callsign = ?", chat, callsign);
  if (known) return known.thread;
  const made = await bot<{ message_thread_id: number }>(f, token, "createForumTopic", { chat_id: chat, name: callsign });
  if (!made.ok) return null;
  await d.run("INSERT OR IGNORE INTO threads (chat, callsign, thread) VALUES (?, ?, ?)", chat, callsign, made.result!.message_thread_id);
  return (await d.first<{ thread: number }>("SELECT thread FROM threads WHERE chat = ? AND callsign = ?", chat, callsign))!.thread;
}

/** Данные кнопки: номер варианта и номер вопроса; подпись читается из самой кнопки. Телеграм даёт на них 64 байта. */
const buttonData = (i: number, ask: string) => `${i}:${ask}`;
const fitsButton = (ask: string) => new TextEncoder().encode(buttonData(99, ask)).length <= 64;

/** Одно сообщение одному чату: в тему сессии; у вопроса — кнопки вариантов. Человек удалил тему — новая тема и ещё одна попытка. */
async function tell(c: Sender, token: string, d: Device, n: Note, again = true): Promise<boolean> {
  const store = db(c.env, c.fleet);
  const thread = n.callsign ? await topic(c.fetch, token, store, d.chat!, n.callsign) : null;
  const text = thread === null && n.callsign ? `${n.callsign} · ${n.title}\n\n${n.text}` : `${n.title}\n\n${n.text}`;
  const buttons = n.ask && n.options?.length && fitsButton(n.ask) ? { reply_markup: { inline_keyboard: n.options.map((label, i) => [{ text: label, callback_data: buttonData(i, n.ask!) }]) } } : {};
  const a = await bot<{ message_id: number }>(c.fetch, token, "sendMessage", { chat_id: d.chat, text, ...(thread === null ? {} : { message_thread_id: thread }), ...buttons });
  if (a.ok) {
    // по этому сообщению ответ человека и нажатая кнопка найдут сессию и там, где тем нет
    if (n.callsign && a.result?.message_id !== undefined)
      await store.batch([
        ["DELETE FROM sent WHERE at < ?", Date.now() - SENT_KEEP],
        ["INSERT OR REPLACE INTO sent (chat, msg, callsign, at) VALUES (?, ?, ?, ?)", d.chat, a.result.message_id, n.callsign, Date.now()],
      ]);
    return true;
  }
  if (threadGone(a) && n.callsign) {
    await store.run("DELETE FROM threads WHERE chat = ? AND callsign = ?", d.chat, n.callsign);
    if (again) return tell(c, token, d, n, false);
  }
  if (a.error_code === 403) await store.run("DELETE FROM devices WHERE id = ?", d.id);
  c.log.warn("Telegram не принял сообщение", { device: d.id, why: a.description });
  return false;
}

/** Секрет вебхука выводится из токена бота: второго секрета нет. */
const hookSecret = (token: string) => sha256hex(`webhook|${token}`);

const SEEN = "👀"; // дошло до машины
const NOBODY = "🤷"; // машина не на связи, сессии нет или код не принят
const REFUSED = "👎"; // отправитель не привязан к флоту
/** Реакцию сразу после сообщения Telegram принимает, но не показывает: ставится через секунду. */
const REACT_MS = 1000;

type TgUser = { id: number; is_bot?: boolean; first_name?: string };
type TgMessage = {
  message_id: number; chat: { id: number; type?: string; is_forum?: boolean }; message_thread_id?: number; from?: TgUser; text?: string; caption?: string;
  reply_to_message?: { message_id: number };
  reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
};
type TgButton = { id: string; from: TgUser; message?: TgMessage; data?: string };
type TgUpdate = { message?: TgMessage; callback_query?: TgButton };

const CODE = /^([a-z0-9][a-z0-9_-]{0,62})-([a-z0-9]{12,})$/i;
const FLEET = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
/** Личный чат: его номер положителен, у групп — отрицателен. */
const isPrivate = (chat: number) => chat > 0;

/** Сессия, о которой сообщение: по теме, иначе по сообщению бота, на которое ответили. */
async function callsignOf(d: Db, chat: number, m: TgMessage): Promise<string | null> {
  if (m.message_thread_id !== undefined) {
    const th = await d.first<{ callsign: string }>("SELECT callsign FROM threads WHERE chat = ? AND thread = ?", chat, m.message_thread_id);
    if (th) return th.callsign;
  }
  const to = m.reply_to_message?.message_id;
  if (to === undefined) return null;
  return (await d.first<{ callsign: string }>("SELECT callsign FROM sent WHERE chat = ? AND msg = ?", chat, to))?.callsign ?? null;
}

/** От чьего имени пишет человек в чате: чат привязан, а в группе человек ещё и сам привязан к флоту (его личный чат или он привязывал группу). Чужой — null. */
async function senderOf(d: Db, platform: Platform, fleet: string, chat: number, user: TgUser | undefined): Promise<string | null> {
  const room = await d.first<Device>("SELECT * FROM devices WHERE id = ?", `tg${chat}`);
  if (!room || !user || user.is_bot) return null;
  let person = room.person, kids = room.kid ? [room.kid] : [];
  if (!isPrivate(chat)) {
    // группа — общий чат: говорить от имени флота может только тот, кто сам привязан
    const own = await d.first<Device>("SELECT devices.* FROM devices JOIN tg ON devices.id = 'tg' || tg.chat WHERE tg.author = ? ORDER BY (tg.chat = ?) DESC, tg.chat > 0 DESC LIMIT 1", user.id, chat);
    if (!own) return null;
    person = own.person;
    if (own.kid) kids = [...kids, own.kid];
  }
  // отозванный пропуск — чат больше не говорит с флотом
  const uniq = [...new Set(kids)];
  if (uniq.length && (await platform.alive(fleet, uniq)).length !== uniq.length) return null;
  return `telegram${person}`;
}

/** Вебхук Telegram флота: код привязки делает чат устройством человека; сообщение в теме сессии уходит сессии кадром message; кнопка вопроса — кадром answer. */
export async function telegram(req: Request, env: Env, exec: ExecutionContext, deps: Deps): Promise<Response> {
  const f = deps.fetch ?? outbound;
  const platform: Platform = deps.platform ?? env.PLATFORM;
  const fleet = new URL(req.url).pathname.split("/")[2] ?? "";
  if (req.method !== "POST" || !FLEET.test(fleet)) return new Response(null, { status: 404 });
  const b = await botOf(env, fleet);
  if (!b) return new Response(null, { status: 404 });
  const token = b.token;
  if (req.headers.get("x-telegram-bot-api-secret-token") !== (await hookSecret(token))) return new Response(null, { status: 401 });
  const u = (await req.json()) as TgUpdate;
  // всегда 200: повтор доставки дал бы двойной ввод
  const done = new Response(null, { status: 200 });
  const d = db(env, fleet);
  const mark = (chat: number, msg: number, emoji: string) => exec.waitUntil(scheduler.wait(REACT_MS).then(() => bot(f, token, "setMessageReaction", { chat_id: chat, message_id: msg, reaction: [{ type: "emoji", emoji }] })));
  const refuse = (word: string, why: string) => log.warn("Telegram: отказ", { module: NAME, fleet, word, why });

  if (u.callback_query) {
    const q = u.callback_query, m = q.message;
    const ack = (text?: string) => bot(f, token, "answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) });
    try {
      const callsign = m ? await callsignOf(d, m.chat.id, { ...m, reply_to_message: { message_id: m.message_id } }) : null;
      const from = m ? await senderOf(d, platform, fleet, m.chat.id, q.from) : null;
      if (!m || !callsign || !from) {
        refuse("not_linked", `кнопка от ${q.from.id}: нет привязки или сессии`);
        await ack("Нет привязки к флоту");
        return done;
      }
      const ask = /^\d+:(.+)$/.exec(q.data ?? "")?.[1];
      const label = m.reply_markup?.inline_keyboard?.flat().find((x) => x.callback_data === q.data)?.text;
      if (!ask || !label) {
        await ack("Вопрос уже снят");
        return done;
      }
      const r = await platform.deliver(fleet, { type: "answer", id: newId("r"), trace: newId("t"), to: callsign, from, ask, answer: label });
      if (!r?.ok) {
        await ack(r?.error === "already_answered" ? "На вопрос уже ответили" : "Машина не на связи");
        if (r?.error !== "already_answered") return done;
      } else await ack();
      await bot(f, token, "editMessageReplyMarkup", { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [] } });
    } catch (e) {
      log.error("вебхук Telegram упал", { module: NAME, fleet, ...errFields(e) });
      await ack("Машина не на связи");
    }
    return done;
  }

  const m = u.message;
  if (!m || m.from?.is_bot) return done;
  const chat = m.chat.id;
  try {
    const code = CODE.exec((m.text ?? "").replace(/^\/start(?:@\w+)?\s+/, "").trim());
    if (code) {
      // группа без тем отказывается до приёма: код не сгорает
      if (!isPrivate(chat) && !m.chat.is_forum) {
        refuse("no_topics", `группа ${chat} без тем`);
        await bot(f, token, "sendMessage", { chat_id: chat, text: "Включите темы в настройках группы и отправьте код снова." });
        return done;
      }
      const row = code[1] === fleet ? await d.first<{ person: string; kid: string; at: number }>("SELECT person, kid, at FROM codes WHERE code = ?", code[0]) : null;
      if (!row || Date.now() - row.at > DAY) {
        refuse("bad_code", `код привязки чата ${chat} не принят`);
        mark(chat, m.message_id, REFUSED);
        return done;
      }
      await d.batch([
        ["INSERT OR REPLACE INTO devices (id, kind, person, label, at, kid, chat) VALUES (?, 'telegram', ?, ?, ?, ?, ?)", `tg${chat}`, row.person, isPrivate(chat) ? "Telegram" : "Telegram · группа", Date.now(), row.kid, chat],
        ["INSERT OR REPLACE INTO tg (chat, author, forum) VALUES (?, ?, ?)", chat, m.from?.id ?? 0, m.chat.is_forum ? 1 : 0],
        ["DELETE FROM codes WHERE code = ?", code[0]],
      ]);
      await bot(f, token, "sendMessage", { chat_id: chat, text: `Привязано: ${row.person}` });
      log.info("чат Telegram привязан", { module: NAME, fleet, person: row.person });
      return done;
    }
    const callsign = await callsignOf(d, chat, m);
    if (!callsign) {
      // General и чужие темы в группе — разговор людей: бот молчит
      if (isPrivate(chat)) mark(chat, m.message_id, NOBODY);
      return done;
    }
    const from = await senderOf(d, platform, fleet, chat, m.from);
    if (!from) {
      refuse("not_linked", `${m.from?.id} не привязан к флоту`);
      mark(chat, m.message_id, REFUSED);
      return done;
    }
    const text = m.text ?? (m.caption ? `${m.caption}\n(вложение не передано)` : undefined);
    if (!text) {
      refuse("not_text", "вложения сессии не передаются");
      mark(chat, m.message_id, NOBODY);
      return done;
    }
    const frame: Frame = { type: "message", id: newId("r"), trace: newId("t"), to: callsign, from, text: isPrivate(chat) || !m.from?.first_name ? text : `${m.from.first_name}: ${text}` };
    const r = await platform.deliver(fleet, frame);
    mark(chat, m.message_id, r?.ok ? SEEN : NOBODY);
  } catch (e) {
    log.error("вебхук Telegram упал", { module: NAME, fleet, ...errFields(e) });
    mark(chat, m.message_id, NOBODY);
  }
  return done;
}

/* ===== Отправка ===== */

/** Позвать человека на все его устройства. На связи и не force — не слать. Отозванный пропуск — устройство убирается. */
export async function sendTo(c: Sender, i: { to: string; title: string; text: string; callsign?: string; kind?: string; force?: boolean; ask?: string; options?: string[] }): Promise<{ sent: number; online: boolean }> {
  const online = await c.platform.online(c.fleet, i.to);
  if (online && !i.force) return { sent: 0, online };
  const d = db(c.env, c.fleet);
  let devices = await d.all<Device>("SELECT * FROM devices WHERE person = ?", i.to);
  const kids = devices.flatMap((x) => (x.kid ? [x.kid] : []));
  if (kids.length) {
    const alive = new Set(await c.platform.alive(c.fleet, kids));
    const dead = devices.filter((x) => x.kid && !alive.has(x.kid));
    if (dead.length) await d.batch(dead.map((x) => ["DELETE FROM devices WHERE id = ?", x.id]));
    devices = devices.filter((x) => !x.kid || alive.has(x.kid));
  }
  const n: Note = {
    title: i.title, text: i.text, ...(i.callsign ? { callsign: i.callsign } : {}), ...(i.kind ? { kind: i.kind } : {}),
    ...(i.ask ? { ask: i.ask } : {}), ...(i.options?.length ? { options: i.options } : {}),
  };
  const plain = c.env.VAPID_PRIVATE ? fit(n) : null;
  const tg = devices.some((x) => x.kind === "telegram") ? await botOf(c.env, c.fleet) : null;
  const sent = await Promise.all(
    devices.map((x) => {
      if (x.kind === "webpush") return plain ? push(c, x, plain) : false;
      return tg ? tell(c, tg.token, x, n) : false;
    }),
  );
  return { sent: sent.filter(Boolean).length, online };
}

/* ===== Запросы ===== */

export const reach: Module = {
  name: NAME,
  handlers: {
    async "reach.send"(i: { to: string; title: string; text: string; callsign?: string; kind?: string; force?: boolean; ask?: string; options?: string[] }, ctx) {
      return sendTo(ctx, i);
    },

    async "reach.key"(_i, ctx) {
      if (!ctx.env.VAPID_PRIVATE) throw new Refusal("no_vapid", "ключ веб-пуша не задан");
      return { key: publicKey(JSON.parse(ctx.env.VAPID_PRIVATE)) };
    },

    async "reach.subscribe"(i: { endpoint: string; p256dh: string; auth: string; label?: string }, ctx) {
      if (!i.endpoint.startsWith("https://") || !URL.canParse(i.endpoint)) throw new Refusal("bad_input", "в подписке нет https-адреса");
      if (!B64U.test(i.p256dh) || !B64U.test(i.auth) || unb64u(i.p256dh).length !== 65 || unb64u(i.auth).length !== 16) throw new Refusal("bad_input", "ключи подписки не того вида");
      const id = "wp" + (await sha256hex(i.endpoint)).slice(0, 20);
      await db(ctx.env, ctx.fleet).run(
        "INSERT OR REPLACE INTO devices (id, kind, person, label, at, kid, endpoint, p256dh, auth) VALUES (?, 'webpush', ?, ?, ?, ?, ?, ?, ?)",
        id, ctx.who.person, i.label ?? null, Date.now(), ctx.who.kid, i.endpoint, i.p256dh, i.auth,
      );
      return { id };
    },

    async "reach.devices"(_i, ctx) {
      const rows = await db(ctx.env, ctx.fleet).all<Device>("SELECT * FROM devices WHERE person = ? ORDER BY at", ctx.who.person);
      return { devices: rows.map((x) => ({ id: x.id, kind: x.kind, person: x.person, at: x.at, ...(x.label ? { label: x.label } : {}), ...(x.kid ? { kid: x.kid } : {}) })) };
    },

    async "reach.remove"(i: { device: string }, ctx) {
      const d = db(ctx.env, ctx.fleet);
      const dev = await d.first<Device>("SELECT * FROM devices WHERE id = ?", i.device);
      if (!dev || (dev.person !== ctx.who.person && !ctx.who.admin)) throw new Refusal("not_found", "такого устройства у вас нет");
      await d.batch([
        ["DELETE FROM devices WHERE id = ?", i.device],
        ...(dev.chat != null ? ([["DELETE FROM tg WHERE chat = ?", dev.chat], ["DELETE FROM threads WHERE chat = ?", dev.chat], ["DELETE FROM sent WHERE chat = ?", dev.chat]] as [string, number][]) : []),
      ]);
      return {};
    },

    /** Код привязки чата: человек шлёт его боту, чат становится его устройством. Код живёт сутки. */
    async "reach.telegram"(_i, ctx) {
      const b = await botOf(ctx.env, ctx.fleet);
      if (!b) throw new Refusal("no_telegram", "бот Telegram не подключён");
      const code = `${ctx.fleet}-${newId()}`;
      await db(ctx.env, ctx.fleet).batch([
        ["DELETE FROM codes WHERE at < ?", Date.now() - DAY],
        ["INSERT INTO codes (code, person, kid, at) VALUES (?, ?, ?, ?)", code, ctx.who.person, ctx.who.kid, Date.now()],
      ]);
      return { code, bot: b.name };
    },

    /** Бот флота: токен проверяется у Telegram, вебхук ставится на адрес этого флота. token null — отключить. Без полей — состояние. */
    async "reach.bot"(i: { token?: string | null }, ctx) {
      const d = db(ctx.env, ctx.fleet);
      const was = await botOf(ctx.env, ctx.fleet);
      if (i.token === undefined) return was ? { bot: was.name, on: true } : { on: false };
      if (i.token === null) {
        if (was) await bot(ctx.fetch, was.token, "deleteWebhook", {});
        await d.run("DELETE FROM bot WHERE one = 1");
        return { on: false };
      }
      const me = await bot<{ username: string }>(ctx.fetch, i.token, "getMe", {});
      if (!me.ok || !me.result?.username) throw new Refusal("bad_token", `Telegram не принял токен бота: ${me.description ?? "нет имени"}`);
      const hook = await bot(ctx.fetch, i.token, "setWebhook", { url: `${ctx.origin}/telegram/${ctx.fleet}`, secret_token: await hookSecret(i.token), allowed_updates: ["message", "callback_query"] });
      if (!hook.ok) throw new Refusal("bad_token", `Telegram не поставил вебхук: ${hook.description}`);
      await d.run("INSERT OR REPLACE INTO bot (one, token, name) VALUES (1, ?, ?)", i.token, me.result.username);
      return { bot: me.result.username, on: true };
    },
  },
};
